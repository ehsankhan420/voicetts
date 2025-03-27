"use client"

import { useState, useRef, useEffect } from "react"
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function VoiceAssistant() {
  const [isCallActive, setIsCallActive] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [context, setContext] = useState("")
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [scriptType, setScriptType] = useState("reliant_bpo")
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [processingAudio, setProcessingAudio] = useState(false)
  const [listeningDuration, setListeningDuration] = useState(0)

  // Browser VAD related refs and state
  const lastSpeechRef = useRef<number>(Date.now())
  const silenceTimer = useRef<NodeJS.Timeout | null>(null)
  const listeningTimerRef = useRef<NodeJS.Timeout | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioAnalyserRef = useRef<AnalyserNode | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const restartTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // VAD configuration
  const silenceThreshold = useRef(0.015)
  const silenceDuration = useRef(1500) // ms before considering speech ended
  const minSpeechFrames = useRef(3) // min frames to consider as speech
  const consecutiveSilenceFramesRef = useRef(0)
  const consecutiveSpeechFramesRef = useRef(0)
  const vadProcessingRef = useRef(false)
  const vadBufferRef = useRef<number[]>([])

  // Add an environment variable notice at the top of the component
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_WS_URL) {
      console.warn("NEXT_PUBLIC_WS_URL environment variable is not set. Using default ws://localhost:8000/ws")
    }
  }, [])

  // Initialize audio element
  useEffect(() => {
    audioElementRef.current = new Audio()

    if (audioElementRef.current) {
      // When audio playback starts (response is playing), stop listening
      audioElementRef.current.onplay = () => {
        setIsSpeaking(true)
        if (isListening) {
          stopRecording()
        }
      }

      // When audio playback ends (response is complete), start listening again if not muted
      audioElementRef.current.onended = () => {
        setIsSpeaking(false)
        resumeListening()
      }

      // Handle errors
      audioElementRef.current.onerror = (e) => {
        console.error("Audio playback error:", e)
        setIsSpeaking(false)
        resumeListening()
      }
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.close()
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      if (silenceTimer.current) {
        clearTimeout(silenceTimer.current)
      }
      if (listeningTimerRef.current) {
        clearInterval(listeningTimerRef.current)
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current)
      }

      // Clean up audio stream
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  // Start/stop audio monitoring based on call state
  useEffect(() => {
    if (isCallActive) {
      // Start listening duration timer
      if (listeningTimerRef.current) {
        clearInterval(listeningTimerRef.current)
      }

      listeningTimerRef.current = setInterval(() => {
        if (isListening && !isSpeaking && !isMuted) {
          setListeningDuration((prev) => prev + 1)
        }
      }, 1000)
    }

    return () => {
      if (silenceTimer.current) {
        clearTimeout(silenceTimer.current)
        silenceTimer.current = null
      }

      if (listeningTimerRef.current) {
        clearInterval(listeningTimerRef.current)
        listeningTimerRef.current = null
      }
    }
  }, [isCallActive, isListening, isSpeaking, isMuted])

  // Connect to WebSocket server
  const connectWebSocket = () => {
    // Use environment variable or fallback to localhost
const wsUrl =
    process.env.NEXT_PUBLIC_WS_URL ||
    (window.location.protocol === "https:"
      ? "wss://purely-prepared-pigeon.ngrok-free.app"
      : "ws://purely-prepared-pigeon.ngrok-free.app");


    console.warn(`⚠️ Warning: Using WebSocket URL: ${wsUrl}`)

    try {
      const socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        console.log("WebSocket connected")
        setIsConnected(true)

        // Send initial context if provided
        if (context.trim()) {
          socket.send(
            JSON.stringify({
              type: "context",
              data: context,
            }),
          )
        }

        // Send script type
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
            // Handle transcribed text from the server
            setMessages((prev) => [...prev, { role: "user", content: data.text }])
          } else if (data.type === "response") {
            // Handle LLM response
            setMessages((prev) => [...prev, { role: "assistant", content: data.text }])
          } else if (data.type === "audio") {
            // Handle audio response (base64 encoded)
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
          } else if (data.type === "vad_settings") {
            // Handle VAD settings from server
            console.log("Received VAD settings from server:", data.settings)
            if (data.settings.threshold) {
              silenceThreshold.current = data.settings.threshold
            }
            if (data.settings.min_silence_ms) {
              silenceDuration.current = data.settings.min_silence_ms
            }
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error)
        }
      }

      socket.onclose = (event) => {
        console.log(`WebSocket disconnected: ${event.code} ${event.reason}`)
        setIsConnected(false)
        setIsCallActive(false)

        // Show disconnection message to user
        if (isCallActive) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "Connection lost. Please try starting the call again.",
            },
          ])
        }
      }

      socket.onerror = (error) => {
        console.error("WebSocket error:", error)
        setIsConnected(false)

        // Show error message to user
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Failed to connect to the voice service. Please check if the server is running and try again.",
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

  // Start call
  const startCall = async () => {
    try {
      // Clear previous messages
      setMessages([])
      setListeningDuration(0)

      // Connect to WebSocket
      connectWebSocket()

      // Initialize audio context with user interaction (required by browsers)
      audioContextRef.current = new AudioContext()

      // Get user media (microphone)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream

      // Set up audio analysis for silence detection
      if (audioContextRef.current) {
        const analyser = audioContextRef.current.createAnalyser()
        analyser.fftSize = 1024 // Increased for better frequency resolution
        analyser.smoothingTimeConstant = 0.5 // Add smoothing for more stable readings
        audioAnalyserRef.current = analyser

        const source = audioContextRef.current.createMediaStreamSource(stream)
        source.connect(analyser)

        // Reset VAD state
        vadBufferRef.current = []
        consecutiveSilenceFramesRef.current = 0
        consecutiveSpeechFramesRef.current = 0
        vadProcessingRef.current = false
        lastSpeechRef.current = Date.now()

        // Start monitoring audio levels
        startAudioMonitoring()
      }

      // Create media recorder
      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      // Set up event handlers
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
            // Only process if we have meaningful audio and we're not already processing
            if (audioBlob.size > 1000 && !processingAudio) {
              setProcessingAudio(true)

              // Convert blob to base64
              const base64Audio = await blobToBase64(audioBlob)

              // Send audio to server
              socketRef.current.send(
                JSON.stringify({
                  type: "audio",
                  data: base64Audio,
                }),
              )
            }
          } catch (error) {
            console.error("Error sending audio:", error)
            setProcessingAudio(false)
            resumeListening()
          }
        }
      }

      // Start recording
      mediaRecorder.start(1000) // Collect data in 1-second chunks
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

  // Browser-based VAD monitoring function
  const startAudioMonitoring = () => {
    if (!audioAnalyserRef.current || !isCallActive) return

    const monitorAudioLevel = () => {
      if (!audioAnalyserRef.current || !isCallActive) return

      // Skip processing if muted or AI is speaking
      if (isMuted || isSpeaking || processingAudio) {
        animationFrameRef.current = requestAnimationFrame(monitorAudioLevel)
        return
      }

      const dataArray = new Uint8Array(audioAnalyserRef.current.frequencyBinCount)
      audioAnalyserRef.current.getByteFrequencyData(dataArray)

      // Calculate average volume level
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length / 255

      // Add to VAD buffer (keep last 10 frames for analysis)
      vadBufferRef.current.push(average)
      if (vadBufferRef.current.length > 10) {
        vadBufferRef.current.shift()
      }

      // Calculate moving average for more stable detection
      const movingAverage = vadBufferRef.current.reduce((sum, value) => sum + value, 0) / vadBufferRef.current.length

      // Dynamic threshold adjustment based on background noise
      const dynamicThreshold = Math.max(
        silenceThreshold.current,
        vadBufferRef.current.length >= 5 ? Math.min(...vadBufferRef.current.slice(0, 5)) * 2 : silenceThreshold.current,
      )

      // Detect if user is speaking using the moving average
      const userIsSpeaking = movingAverage > dynamicThreshold

      if (userIsSpeaking) {
        // User is speaking
        lastSpeechRef.current = Date.now()
        consecutiveSilenceFramesRef.current = 0
        consecutiveSpeechFramesRef.current++

        if (consecutiveSpeechFramesRef.current >= minSpeechFrames.current && !isSpeaking) {
          // User started speaking (with confirmation to avoid false positives)
          setIsSpeaking(true)

          // Clear any existing silence timer
          if (silenceTimer.current) {
            clearTimeout(silenceTimer.current)
            silenceTimer.current = null
          }
        }
      } else {
        // User is not speaking
        consecutiveSpeechFramesRef.current = 0
        consecutiveSilenceFramesRef.current++

        // Check if we've been silent for a while after speaking
        if (
          isSpeaking &&
          consecutiveSilenceFramesRef.current >= 15 &&
          !vadProcessingRef.current &&
          Date.now() - lastSpeechRef.current >= 300
        ) {
          // User has been silent for enough frames after speaking
          vadProcessingRef.current = true

          // Start silence timer for final confirmation
          if (!silenceTimer.current) {
            silenceTimer.current = setTimeout(() => {
              // User has been silent for the threshold period
              setIsSpeaking(false)
              vadProcessingRef.current = false

              // Stop recording to process the audio
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                console.log("VAD detected end of speech, stopping recorder to process audio")
                stopRecording()
              }
            }, silenceDuration.current) // Configurable silence duration before processing
          }
        }
      }

      // Continue monitoring
      animationFrameRef.current = requestAnimationFrame(monitorAudioLevel)
    }

    // Start the monitoring loop
    monitorAudioLevel()
  }

  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop()
      setIsListening(false)
    }

    // Clear any silence timer
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current)
      silenceTimer.current = null
    }
  }

  // End call
  const endCall = () => {
    stopRecording()

    if (socketRef.current) {
      socketRef.current.close()
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    setIsCallActive(false)
    setIsListening(false)
    setIsSpeaking(false)
    setListeningDuration(0)
  }

  // Toggle mute
  const toggleMute = () => {
    setIsMuted(!isMuted)

    if (!isMuted) {
      // Muting - stop recording
      stopRecording()
      setIsSpeaking(false)

      // Clear any silence timer
      if (silenceTimer.current) {
        clearTimeout(silenceTimer.current)
        silenceTimer.current = null
      }
    } else {
      // Unmuting - start recording again
      resumeListening()
    }
  }

  // Resume listening
  const resumeListening = () => {
    if (isCallActive && !isMuted && !isSpeaking && mediaRecorderRef.current) {
      // Reset VAD state before resuming
      vadBufferRef.current = []
      consecutiveSilenceFramesRef.current = 0
      consecutiveSpeechFramesRef.current = 0
      vadProcessingRef.current = false
      lastSpeechRef.current = Date.now()

      if (mediaRecorderRef.current.state !== "recording") {
        mediaRecorderRef.current.start(1000)
        setIsListening(true)
      }
    }
  }

  // Convert blob to base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64String = reader.result as string
        // Remove the data URL prefix
        const base64 = base64String.split(",")[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  // Convert base64 to blob
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

  // Play audio
  const playAudio = (audioBlob: Blob) => {
    const url = URL.createObjectURL(audioBlob)
    if (audioElementRef.current) {
      // Stop listening while response is playing
      stopRecording()

      audioElementRef.current.src = url
      audioElementRef.current.play().catch((error) => {
        console.error("Error playing audio:", error)
        // If playback fails, resume listening
        setIsSpeaking(false)
        resumeListening()
      })

      // Set processing to false once we start playing the response
      setProcessingAudio(false)
    }
  }

  const getConnectionStatusMessage = () => {
    if (!isCallActive) return null

    if (!isConnected) {
      return (
        <div className="flex justify-center my-2">
          <div className="bg-destructive text-destructive-foreground px-3 py-1 rounded-md text-sm">
            Disconnected from server
          </div>
        </div>
      )
    }

    return null
  }

  // Format time for display
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`
  }

  // Handle script type change
  const handleScriptTypeChange = (value: string) => {
    setScriptType(value)

    // If already connected, send the new script type to the server
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
                    {isSpeaking ? "Speech detected..." : `Listening... ${formatTime(listeningDuration)}`}
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

