import asyncio
import json
import base64
import os
import io
import torch
import websockets
from groq import Groq
from faster_whisper import WhisperModel
from TTS.api import TTS

# Configuration
WEBSOCKET_PORT = 8000
WEBSOCKET_HOST = "0.0.0.0"  # Listen on all interfaces
GROQ_API_KEY = "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"  # Replace with your actual API key

# Initialize Groq client - Fixed initialization without proxies
try:
    # Try the simple initialization first
    groq_client = Groq(api_key=GROQ_API_KEY)
except TypeError:
    # If that fails, try with specific parameters
    import httpx
    groq_client = Groq(
        api_key=GROQ_API_KEY,
        http_client=httpx.Client(
            base_url="https://api.groq.com",
            timeout=60.0,
            follow_redirects=True
        )
    )

# Initialize Whisper model
print("Initializing Whisper model...")
num_cores = os.cpu_count()
whisper_model = WhisperModel(
    "base",
    device="cpu",
    compute_type="int8",
    cpu_threads=num_cores // 2 if num_cores else 2,
    num_workers=num_cores // 2 if num_cores else 2
)
print("Whisper model initialized.")

# Initialize TTS model
print("Initializing TTS model...")
device = "cuda" if torch.cuda.is_available() else "cpu"
tts_model = TTS(model_name='tts_models/en/ljspeech/tacotron2-DDC').to(device)
print(f"TTS model initialized on {device}.")

# Store conversation context for each client
client_contexts = {}

async def process_audio(audio_data, websocket):
    """Process audio data: transcribe, get LLM response, and generate speech"""
    client_id = id(websocket)
    context = client_contexts.get(client_id, {}).get("context", "")
    
    try:
        # Save audio data to a temporary file
        audio_bytes = base64.b64decode(audio_data)
        temp_audio_path = f"temp_audio_{client_id}.wav"
        
        with open(temp_audio_path, "wb") as f:
            f.write(audio_bytes)
        
        print(f"Transcribing audio for client {client_id}...")
        # Transcribe audio using Whisper
        segments, _ = whisper_model.transcribe(temp_audio_path)
        transcribed_text = ''.join(segment.text for segment in segments)
        
        # Clean up temporary file
        if os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
        
        if not transcribed_text.strip():
            print("No transcription detected.")
            return
        
        print(f"Transcription: {transcribed_text}")
        
        # Send transcription back to client
        await websocket.send(json.dumps({
            "type": "transcription",
            "text": transcribed_text
        }))
        
        # Prepare conversation history
        conversation_history = client_contexts.get(client_id, {}).get("history", [])
        
        # Add user message to history
        conversation_history.append({"role": "user", "content": transcribed_text})
        
        # Prepare system message with context if available
        messages = []
        if context:
            messages.append({
                "role": "system", 
                "content": f"You are a helpful voice assistant. Context for this conversation: {context}"
            })
        else:
            messages.append({
                "role": "system", 
                "content": "You are a helpful voice assistant. Provide concise and clear responses suitable for voice conversations."
            })
        
        # Add conversation history
        messages.extend(conversation_history)
        
        print("Getting response from Groq...")
        # Get response from Groq
        chat_completion = groq_client.chat.completions.create(
            messages=messages,
            model='llama3-70b-8192'
        )
        
        response_text = chat_completion.choices[0].message.content
        print(f"Groq response: {response_text}")
        
        # Add assistant response to history
        conversation_history.append({"role": "assistant", "content": response_text})
        
        # Update client context
        client_contexts[client_id] = {
            "context": context,
            "history": conversation_history
        }
        
        # Send text response to client
        await websocket.send(json.dumps({
            "type": "response",
            "text": response_text
        }))
        
        print("Generating speech from response...")
        # Generate speech from response
        temp_output_path = f"temp_output_{client_id}.wav"
        tts_model.tts_to_file(text=response_text, file_path=temp_output_path)
        
        # Read the audio file and convert to base64
        with open(temp_output_path, "rb") as f:
            audio_bytes = f.read()
        
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
        
        # Clean up temporary file
        if os.path.exists(temp_output_path):
            os.remove(temp_output_path)
        
        print("Sending audio response to client...")
        # Send audio response to client
        await websocket.send(json.dumps({
            "type": "audio",
            "audio": audio_base64
        }))
        
    except Exception as e:
        print(f"Error processing audio: {e}")
        # Send error message to client
        await websocket.send(json.dumps({
            "type": "error",
            "message": str(e)
        }))

async def handle_websocket(websocket, path):
    """Handle WebSocket connection"""
    client_id = id(websocket)
    client_contexts[client_id] = {"context": "", "history": []}
    
    print(f"New client connected: {client_id}")
    
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                
                if data["type"] == "audio":
                    # Process audio data
                    await process_audio(data["data"], websocket)
                    
                elif data["type"] == "context":
                    # Store context for this client
                    client_contexts[client_id]["context"] = data["data"]
                    print(f"Received context from client {client_id}")
                    
            except json.JSONDecodeError:
                print("Error: Invalid JSON")
                await websocket.send(json.dumps({
                    "type": "error",
                    "message": "Invalid JSON format"
                }))
                
    except websockets.exceptions.ConnectionClosed as e:
        print(f"Connection closed for client {client_id}: {e.code} {e.reason}")
    except Exception as e:
        print(f"Unexpected error for client {client_id}: {str(e)}")
    finally:
        # Clean up client context when connection is closed
        if client_id in client_contexts:
            del client_contexts[client_id]
        print(f"Client disconnected: {client_id}")

async def main():
    """Start WebSocket server"""
    print(f"Starting WebSocket server on {WEBSOCKET_HOST}:{WEBSOCKET_PORT}...")
    
    # Create a WebSocket server with CORS support
    async with websockets.serve(
        handle_websocket, 
        WEBSOCKET_HOST, 
        WEBSOCKET_PORT,
        # Add CORS headers
        process_request=lambda path, request_headers: None,
        extra_headers=[
            ('Access-Control-Allow-Origin', '*'),
            ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
            ('Access-Control-Allow-Headers', 'Content-Type'),
        ]
    ):
        print(f"WebSocket server running on {WEBSOCKET_HOST}:{WEBSOCKET_PORT}")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Server stopped by user")
    except Exception as e:
        print(f"Server error: {str(e)}")

