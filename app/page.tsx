"use client"

import { useState, useRef, useEffect } from "react"
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react'
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

export default function VoiceAssistant() {
  const [isCallActive, setIsCallActive] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [context, setContext] = useState("")
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isListening, setIsListening] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioElementRef = useRef<HTMLAudioElement | null>(null)

  // Add an environment variable notice at the top of the component
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_WS_URL) {
      console.warn("NEXT_PUBLIC_WS_URL environment variable is not set. Using default ws://localhost:8000/ws")
    }
  }, [])

  // Initialize audio element
  useEffect(() => {
    audioElementRef.current = new Audio()
    return () => {
      if (socketRef.current) {
        socketRef.current.close()
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  // Connect to WebSocket server
  const connectWebSocket = () => {
    // Use environment variable or fallback to localhost
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws"

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
// Start call
const startCall = async () => {
  try {
    // Clear previous messages
    setMessages([]);

    // Connect to WebSocket
    connectWebSocket();

    // Initialize audio context with user interaction (required by browsers)
    audioContextRef.current = new AudioContext();

    // Get user media (microphone)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Create media recorder
    const mediaRecorder = new MediaRecorder(stream);
    mediaRecorderRef.current = mediaRecorder;

    // Set up event handlers
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunksRef.current.length > 0 && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        audioChunksRef.current = [];

        try {
          // Convert blob to base64
          const base64Audio = await blobToBase64(audioBlob);

          // Send audio to server
          socketRef.current.send(
            JSON.stringify({
              type: "audio",
              data: base64Audio,
            })
          );
        } catch (error) {
          console.error("Error sending audio:", error);
        }
      }
    };

    // Start recording
    mediaRecorder.start(1000); // Collect data in 1-second chunks
    setIsCallActive(true);
    setIsListening(true);
  } catch (error: unknown) {
    console.error("Error starting call:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `Failed to start call: ${errorMessage}. Please ensure you've granted microphone permissions.`,
      },
    ]);
  }
};


  // End call
  const endCall = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop()
    }

    if (socketRef.current) {
      socketRef.current.close()
    }

    setIsCallActive(false)
    setIsListening(false)
  }

  // Toggle mute
  const toggleMute = () => {
    setIsMuted(!isMuted)

    if (mediaRecorderRef.current) {
      if (!isMuted) {
        // Muting - stop recording
        mediaRecorderRef.current.stop()
        setIsListening(false)
      } else {
        // Unmuting - start recording again
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
      audioElementRef.current.src = url
      audioElementRef.current.play().catch((error) => {
        console.error("Error playing audio:", error)
      })
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

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="bg-primary text-primary-foreground">
          <CardTitle className="text-center">AI Voice Assistant</CardTitle>
        </CardHeader>

        <CardContent className="p-4 space-y-4">
          {getConnectionStatusMessage()}
          {!isCallActive && (
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