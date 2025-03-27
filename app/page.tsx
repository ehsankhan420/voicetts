"use client"

import { useState, useRef, useEffect } from "react"
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

declare global {
  interface SpeechRecognitionConstructor {
    new(): SpeechRecognition;
  }

  interface Window {
    SpeechRecognition: SpeechRecognitionConstructor;
    webkitSpeechRecognition: SpeechRecognitionConstructor;
  }
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onresult: (event: SpeechRecognitionEvent) => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export default function VoiceAssistant() {
  const [isCallActive, setIsCallActive] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [context, setContext] = useState("")
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [scriptType, setScriptType] = useState("reliant_bpo")
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [silenceTimer, setSilenceTimer] = useState<NodeJS.Timeout | null>(null)
  const [processingAudio, setProcessingAudio] = useState(false)
  const [transcription, setTranscription] = useState("")
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const lastSpeechRef = useRef<number>(Date.now())

  const socketRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_WS_URL) {
      console.warn("NEXT_PUBLIC_WS_URL environment variable is not set. Using default ws://localhost:8000/ws")
    }
  }, [])

  useEffect(() => {
    audioElementRef.current = new Audio()

    const audioElement = audioElementRef.current
    audioElement.onplay = () => {
      if (isListening && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop()
        setIsListening(false)
      }
    }

    audioElement.onended = () => {
      setIsSpeaking(false)
      resumeListening()
    }

    audioElement.onerror = () => {
      setIsSpeaking(false)
      resumeListening()
    }

    return () => {
      if (audioElement) {
        audioElement.onplay = null
        audioElement.onended = null
        audioElement.onerror = null
      }
      cleanupResources()
    }
  }, [])

  const cleanupResources = () => {
    if (socketRef.current) {
      socketRef.current.close()
      socketRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer)
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = null
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stream?.getTracks().forEach(track => track.stop())
      mediaRecorderRef.current = null
    }
  }

  const setupPingInterval = (socket: WebSocket) => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current)
    }

    const pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }))
      } else {
        clearInterval(pingInterval)
      }
    }, 25000) // Send a ping every 25 seconds

    pingIntervalRef.current = pingInterval
    return pingInterval
  }

  const connectWebSocket = () => {
    const wsUrl =
      process.env.NEXT_PUBLIC_WS_URL ||
      (window.location.protocol === "https:"
        ? "wss://purely-prepared-pigeon.ngrok-free.app"
        : "ws://purely-prepared-pigeon.ngrok-free.app")

    console.log(`Connecting to WebSocket at: ${wsUrl}`)

    try {
      const socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        console.log("WebSocket connected")
        setIsConnected(true)
        setReconnectAttempts(0)
        
        setupPingInterval(socket)

        if (context.trim()) {
          socket.send(
            JSON.stringify({
              type: "context",
              data: context,
            }),
          )
        }

        socket.send(
          JSON.stringify({
            type: "script_type",
            data: scriptType,
          }),
        )
      }

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (data.type === "transcription") {
            setMessages((prev) => [...prev, { role: "user", content: data.text }])
          } else if (data.type === "response") {
            setMessages((prev) => [...prev, { role: "assistant", content: data.text }])
          } else if (data.type === "audio") {
            const audioBlob = base64ToBlob(data.audio, "audio/wav")
            playAudio(audioBlob)
          } else if (data.type === "error") {
            console.error("Server error:", data.message)
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: `Error: ${data.message}. Please try again.`,
              },
            ])
          } else if (data.type === "info") {
            console.log("Server info:", data.message)
          } else if (data.type === "pong") {
            console.log("Received pong from server")
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
        }
      }

      socket.onclose = (event) => {
        console.log(`WebSocket disconnected: ${event.code} ${event.reason}`)
        setIsConnected(false)

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current)
          pingIntervalRef.current = null
        }

        // Don't attempt to reconnect if the call is not active
        if (!isCallActive) return

        // Don't attempt to reconnect if this was a normal closure
        if (event.code === 1000) return

        // Exponential backoff for reconnection
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        console.log(`Attempting to reconnect in ${delay}ms...`)

        setTimeout(() => {
          if (isCallActive) {
            setReconnectAttempts(prev => prev + 1)
            connectWebSocket()
          }
        }, delay)
      }

      socket.onerror = (error) => {
        console.error("WebSocket error:", error)
        setIsConnected(false)
        
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Connection error. Attempting to reconnect...",
          },
        ])
      }

      socketRef.current = socket
    } catch (error) {
      console.error("Error creating WebSocket:", error)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Failed to initialize connection. Please try again later.",
        },
      ])
    }
  }

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (e) {
        console.error("Error stopping recognition:", e)
      }
    }
  }

  const processAudio = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording" && !processingAudio) {
      mediaRecorderRef.current.stop()
      setIsListening(false)
    }
  }

  const startCall = async () => {
    try {
      setMessages([])
      connectWebSocket()
      
      // Initialize audio context only if not already created
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext()
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        if (
          audioChunksRef.current.length > 0 &&
          socketRef.current &&
          socketRef.current.readyState === WebSocket.OPEN &&
          !isMuted
        ) {
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" })
          audioChunksRef.current = []

          try {
            if (audioBlob.size > 1000 && !processingAudio) {
              setProcessingAudio(true)
              const base64Audio = await blobToBase64(audioBlob)

              if (socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.send(
                  JSON.stringify({
                    type: "audio",
                    data: base64Audio,
                  }),
                )
              } else {
                console.error("WebSocket not open, cannot send audio")
                setProcessingAudio(false)
              }
            }
          } catch (error) {
            console.error("Error sending audio:", error)
            setProcessingAudio(false)
          }
        }
      }

      // Initialize speech recognition
      const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SpeechRecognitionAPI) {
        throw new Error("Speech recognition not supported in this browser")
      }

      recognitionRef.current = new SpeechRecognitionAPI()
      if (recognitionRef.current) {
        recognitionRef.current.continuous = true
        recognitionRef.current.interimResults = true

        recognitionRef.current.onresult = (event: SpeechRecognitionEvent) => {
          if (isMuted || isSpeaking) return

          lastSpeechRef.current = Date.now()

          let finalTranscript = ""
          let interimTranscript = ""

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript
            } else {
              interimTranscript += event.results[i][0].transcript
            }
          }

          const transcript = finalTranscript || interimTranscript
          setTranscription(transcript)

          if (silenceTimer) {
            clearTimeout(silenceTimer)
          }

          const timer = setTimeout(() => {
            if (transcript.trim() && Date.now() - lastSpeechRef.current >= 1500 && !isMuted && !isSpeaking) {
              stopRecognition()
              processAudio()
            }
          }, 1500)

          setSilenceTimer(timer)
        }

        recognitionRef.current.onerror = (event) => {
          console.error("Speech recognition error:", event)
          // Attempt to restart recognition
          setTimeout(() => {
            if (recognitionRef.current && isCallActive && !isMuted) {
              try {
                recognitionRef.current.start()
              } catch (e) {
                console.error("Failed to restart speech recognition:", e)
              }
            }
          }, 500)
        }

        recognitionRef.current.start()
      }
      
      mediaRecorder.start(1000)
      setIsCallActive(true)
      setIsListening(true)
    } catch (error: unknown) {
      console.error("Error starting call:", error)
      const errorMessage = error instanceof Error ? error.message : "Unknown error"
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Failed to start call: ${errorMessage}. Please ensure you've granted microphone permissions.`,
        },
      ])
    }
  }

  const endCall = () => {
    cleanupResources()
    setIsCallActive(false)
    setIsListening(false)
    setIsConnected(false)
    setReconnectAttempts(0)
  }

  const toggleMute = () => {
    setIsMuted(!isMuted)

    if (mediaRecorderRef.current) {
      if (!isMuted) {
        mediaRecorderRef.current.stop()
        setIsListening(false)
        setIsSpeaking(false)

        if (silenceTimer) {
          clearTimeout(silenceTimer)
          setSilenceTimer(null)
        }
      } else {
        if (mediaRecorderRef.current.state !== "recording") {
          mediaRecorderRef.current.start(1000)
          setIsListening(true)
        }
      }
    }
  }

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64String = reader.result as string
        const base64 = base64String.split(",")[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  const base64ToBlob = (base64: string, mimeType: string): Blob => {
    const byteCharacters = atob(base64)
    const byteArrays = []

    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512)

      const byteNumbers = new Array(slice.length)
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i)
      }

      const byteArray = new Uint8Array(byteNumbers)
      byteArrays.push(byteArray)
    }

    return new Blob(byteArrays, { type: mimeType })
  }

  const playAudio = (audioBlob: Blob) => {
    const url = URL.createObjectURL(audioBlob)
    if (audioElementRef.current) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop()
        setIsListening(false)
      }

      setIsSpeaking(true)
      audioElementRef.current.src = url
      audioElementRef.current.play().catch((error) => {
        console.error("Error playing audio:", error)
        setIsSpeaking(false)
        resumeListening()
      })

      setProcessingAudio(false)
    }
  }

  const resumeListening = () => {
    if (!isCallActive || isMuted) return

    // Ensure we're not already listening
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "recording") {
      mediaRecorderRef.current.start(1000)
      setIsListening(true)
    }

    // Restart speech recognition if it's not already running
    if (recognitionRef.current) {
      try {
        // First stop it to reset any potential error state
        recognitionRef.current.stop()
      } catch (e) {
        // Ignore errors when stopping - it might not be running
      }

      try {
        // Then start it again
        setTimeout(() => {
          if (recognitionRef.current && isCallActive && !isMuted) {
            recognitionRef.current.start()
          }
        }, 100) // Small delay to ensure stop completes
      } catch (e) {
        console.error("Error restarting speech recognition:", e)
      }
    }
  }

  const getConnectionStatusMessage = () => {
    if (!isCallActive) return null

    if (!isConnected) {
      return (
        <div className="flex justify-center my-2">
          <div className="bg-destructive text-destructive-foreground px-3 py-1 rounded-md text-sm">
            Disconnected from server - attempting to reconnect...
          </div>
        </div>
      )
    }

    return null
  }

  const handleScriptTypeChange = (value: string) => {
    setScriptType(value)

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "script_type",
          data: value,
        }),
      )
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="bg-primary text-primary-foreground">
          <CardTitle className="text-center">AI Voice Assistant</CardTitle>
        </CardHeader>

        <CardContent className="p-4 space-y-4">
          {getConnectionStatusMessage()}
          {!isCallActive && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="script-type" className="text-sm font-medium">
                  BPO Script Type
                </label>
                <Select value={scriptType} onValueChange={handleScriptTypeChange}>
                  <SelectTrigger id="script-type">
                    <SelectValue placeholder="Select script type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reliant_bpo">Reliant BPO</SelectItem>
                    <SelectItem value="21st_bpo">21st BPO</SelectItem>
                    <SelectItem value="sirus_solutions">Sirus Solutions</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label htmlFor="context" className="text-sm font-medium">
                  Call Context (optional)
                </label>
                <Textarea
                  id="context"
                  placeholder="Provide context for this call..."
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  className="min-h-[100px]"
                />
              </div>
            </div>
          )}

          {isCallActive && (
            <div className="space-y-4 max-h-[400px] overflow-y-auto">
              {messages.map((message, index) => (
                <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="flex items-start gap-2 max-w-[80%]">
                    {message.role === "assistant" && (
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>AI</AvatarFallback>
                      </Avatar>
                    )}
                    <div
                      className={`rounded-lg p-3 ${
                        message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                      }`}
                    >
                      {message.content}
                    </div>
                    {message.role === "user" && (
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>You</AvatarFallback>
                      </Avatar>
                    )}
                  </div>
                </div>
              ))}

              {isListening && (
                <div className="flex justify-center">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                    </span>
                    Listening...
                  </div>
                </div>
              )}

              {processingAudio && !isListening && (
                <div className="flex justify-center">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="relative flex h-3 w-3">
                      <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                    </span>
                    Processing...
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>

        <CardFooter className="flex justify-center gap-4 p-4 bg-muted/50">
          {!isCallActive ? (
            <Button onClick={startCall} className="bg-green-600 hover:bg-green-700">
              <Phone className="mr-2 h-4 w-4" />
              Start Call
            </Button>
          ) : (
            <>
              <Button
                onClick={toggleMute}
                variant={isMuted ? "default" : "outline"}
                className={isMuted ? "bg-amber-600 hover:bg-amber-700" : ""}
              >
                {isMuted ? (
                  <>
                    <MicOff className="mr-2 h-4 w-4" />
                    Unmute
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-4 w-4" />
                    Mute
                  </>
                )}
              </Button>

              <Button onClick={endCall} variant="destructive">
                <PhoneOff className="mr-2 h-4 w-4" />
                End Call
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
