class SalesAgentApp {
    constructor() {
        console.log('SalesAgentApp constructor called');
        this.socket = null;
        this.mediaRecorder = null;
        this.isRecording = false;
        this.isMuted = false;
        this.isLoggedIn = false;
        this.token = null;
        this.sessionId = null;
        this.currentUser = null;
        this.audioChunks = [];
        this.callStartTime = null;
        this.callTimer = null;
        
        // AudioWorklet properties for low-latency audio
        this.audioContext = null;
        this.audioWorkletNode = null;
        this.stream = null;
        this.useAudioWorklet = true; // Flag to enable/disable AudioWorklet
        
        // API Configuration - automatically detects environmentmc
        this.config = {
            // Use environment variable or fallback to localhost for development
            apiUrl: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
                ? 'http://localhost:8000' 
                : 'https://e161b9c2e914.ngrok-free.app', // Ngrok URL for backend
            wsUrl: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
                ? 'ws://localhost:8000'
                : 'wss://e161b9c2e914.ngrok-free.app' // Ngrok URL for WebSocket
        };
        
        console.log('Environment detected:', window.location.hostname);
        console.log('Using API URL:', this.config.apiUrl);
        console.log('Using WebSocket URL:', this.config.wsUrl);
    }

    async init() {
        this.showLogin();
    }

    showLogin() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('mainApp').classList.add('hidden');
        
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleLogin();
        });
    }

    async handleLogin() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        if (!username || !password) {
            this.showError('Please enter both username and password');
            return;
        }

        try {
            console.log('Attempting login with:', username);
            const response = await fetch(`${this.config.apiUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            console.log('Login response status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                console.log('Login successful:', data);
                this.token = data.access_token;
                this.sessionId = data.session_id;
                this.currentUser = username;
                this.isLoggedIn = true;
                
                this.showMainApp();
                await this.connectWebSocket();
                this.startCallTimer();
                
            } else {
                const error = await response.json();
                console.error('Login failed:', error);
                this.showError('Login failed: ' + error.detail);
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showError('Login failed. Please check your connection and try again.');
        }
    }

    showMainApp() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('mainApp').classList.remove('hidden');
        
        // Setup event listeners
        document.getElementById('micBtn').addEventListener('click', () => {
            this.toggleRecording();
        });
        
        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });
        
        // End Call button
        document.getElementById('endCallBtn').addEventListener('click', () => {
            this.showEndCallModal();
        });
        
        // Mute button
        document.getElementById('muteBtn').addEventListener('click', () => {
            this.toggleMute();
        });
        
        // Modal buttons
        document.getElementById('confirmEndCall').addEventListener('click', () => {
            this.endCall();
        });
        
        document.getElementById('cancelEndCall').addEventListener('click', () => {
            this.hideEndCallModal();
        });
        
        // Update user info if there's a currentUser element
        const userElement = document.getElementById('currentUser');
        if (userElement) {
            userElement.textContent = this.currentUser;
        }
    }

    async connectWebSocket() {
        try {
            console.log('Connecting to WebSocket with session ID:', this.sessionId);
            this.socket = new WebSocket(`${this.config.wsUrl}/ws/${this.sessionId}`);
            
            this.socket.onopen = () => {
                console.log('WebSocket connected');
                this.updateConnectionStatus(true);
                this.addMessage('System', 'Connected! Click the microphone to start speaking.', 'system');
            };
            
            this.socket.onmessage = (event) => {
                this.handleWebSocketMessage(event);
            };
            
            this.socket.onclose = () => {
                console.log('WebSocket disconnected');
                this.updateConnectionStatus(false);
                this.addMessage('System', 'Connection lost. Please refresh the page.', 'system');
            };
            
            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateConnectionStatus(false);
            };
            
        } catch (error) {
            console.error('WebSocket connection error:', error);
            this.showError('Failed to connect to server');
        }
    }

    handleWebSocketMessage(event) {
        const message = JSON.parse(event.data);
        console.log('WebSocket message received:', message.type);
        
        switch (message.type) {
            case 'transcription':
                this.addMessage('You', message.text, 'user');
                break;
                
            case 'ai_response':
                this.addMessage('Lisa (AI Agent)', message.text, 'agent');
                if (message.audio) {
                    this.playAudio(message.audio, message.sample_rate, message.format);
                }
                break;
                
            case 'partial_transcription':
                this.showPartialTranscription(message.text);
                break;
                
            case 'session_update':
                this.updateSessionInfo(message.data);
                break;
                
            case 'error':
                console.error('Server error:', message.message);
                this.showError('Server error: ' + message.message);
                break;
        }
    }

    async toggleRecording() {
        if (!this.isRecording) {
            await this.startRecording();
        } else {
            this.stopRecording();
        }
    }

    async startRecording() {
        try {
            console.log('[DEBUG] Starting recording...');
            
            if (this.useAudioWorklet && window.AudioWorklet) {
                await this.startAudioWorkletRecording();
            } else {
                await this.startMediaRecorderRecording();
            }
            
        } catch (error) {
            console.error('Recording start error:', error);
            this.showError('Failed to start recording: ' + error.message);
        }
    }

    async startAudioWorkletRecording() {
        try {
            console.log('[DEBUG] Starting AudioWorklet recording for low latency...');
            
            // Get microphone stream with optimal settings for Vosk
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    sampleRate: 16000,  // Vosk optimal sample rate
                    channelCount: 1,    // Mono audio
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            });
            
            // Create AudioContext with 16kHz sample rate
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            
            // Resume context if suspended
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            // Load AudioWorklet processor
            await this.audioContext.audioWorklet.addModule('/audio-processor-pcm32.js');
            
            // Create AudioWorklet node
            this.audioWorkletNode = new AudioWorkletNode(
                this.audioContext, 
                'pcm32-audio-processor'
            );
            
            // Handle audio data from worklet
            this.audioWorkletNode.port.onmessage = (event) => {
                if (event.data.type === 'audioData') {
                    this.sendAudioWorkletData(event.data);
                }
            };
            
            // Connect audio pipeline
            const source = this.audioContext.createMediaStreamSource(this.stream);
            source.connect(this.audioWorkletNode);
            
            this.isRecording = true;
            this.updateMicButton();
            
            console.log('[DEBUG] AudioWorklet recording started successfully');
            
        } catch (error) {
            console.error('AudioWorklet recording error:', error);
            // Fallback to MediaRecorder
            console.log('[DEBUG] Falling back to MediaRecorder...');
            this.useAudioWorklet = false;
            await this.startMediaRecorderRecording();
        }
    }

    async startMediaRecorderRecording() {
        try {
            console.log('[DEBUG] Starting MediaRecorder recording (fallback)...');
            
            if (!this.stream) {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            
            // Configure MediaRecorder for WebM format explicitly
            const options = { mimeType: 'audio/webm' };
            this.mediaRecorder = new MediaRecorder(this.stream, options);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                this.processAudioChunks();
            };

            this.mediaRecorder.start(100); // Collect data every 100ms
            this.isRecording = true;
            this.updateMicButton();
            
            console.log('[DEBUG] MediaRecorder recording started');
            
        } catch (error) {
            console.error('MediaRecorder error:', error);
            throw error;
        }
    }

    sendAudioWorkletData(audioData) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                // Send metadata first
                this.socket.send(JSON.stringify({
                    type: 'audio_pcm16',
                    samples: audioData.samples,
                    sampleRate: audioData.sampleRate,
                    timestamp: audioData.timestamp,
                    format: 'pcm16'
                }));
                
                // Send binary PCM data
                this.socket.send(audioData.data);
                
                console.log('[DEBUG] Sent PCM16 audio data:', audioData.samples, 'samples');
                
            } catch (error) {
                console.error('[DEBUG] Error sending AudioWorklet data:', error);
            }
        } else {
            console.log('[DEBUG] WebSocket not open, cannot send AudioWorklet data');
        }
    }

    stopRecording() {
        if (!this.isRecording) return;
        
        if (this.audioWorkletNode && this.useAudioWorklet) {
            // Stop AudioWorklet recording
            if (this.audioWorkletNode) {
                this.audioWorkletNode.disconnect();
                this.audioWorkletNode = null;
            }
            
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }
            
            console.log('[DEBUG] AudioWorklet recording stopped');
            
        } else if (this.mediaRecorder) {
            // Stop MediaRecorder recording
            this.mediaRecorder.stop();
            
            // Stop all tracks
            if (this.mediaRecorder.stream) {
                this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
            
            console.log('[DEBUG] MediaRecorder recording stopped');
        }
        
        this.isRecording = false;
        this.updateMicButton();
    }

    async processAudioChunks() {
        if (this.audioChunks.length === 0) {
            console.log('[DEBUG] No audio chunks to process.');
            return;
        }

        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        console.log('[DEBUG] Audio blob size:', audioBlob.size);
        const audioData = await this.blobToBase64(audioBlob);
        console.log('[DEBUG] Audio base64 length:', audioData.length);
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log('[DEBUG] Sending audio to backend via WebSocket.');
            this.socket.send(JSON.stringify({
                type: 'audio',
                data: audioData,
                format: 'webm'
            }));
        } else {
            console.log('[DEBUG] WebSocket not open, cannot send audio.');
        }
        this.audioChunks = [];
    }

    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    playAudio(audioData, sampleRate, format) {
        try {
            console.log('Playing audio:', format, 'Sample rate:', sampleRate);
            
            if (format === 'pcm16') {
                // Handle raw PCM16 data using Web Audio API
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const audioBytes = this.base64ToArrayBuffer(audioData);
                const pcmData = new Int16Array(audioBytes);
                
                // Create audio buffer
                const audioBuffer = audioContext.createBuffer(1, pcmData.length, sampleRate);
                const channelData = audioBuffer.getChannelData(0);
                
                // Convert Int16 to Float32 for Web Audio API
                for (let i = 0; i < pcmData.length; i++) {
                    channelData[i] = pcmData[i] / 32768.0;
                }
                
                // Play the audio
                const source = audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContext.destination);
                source.start();
                
                console.log('PCM16 audio played successfully');
            } else {
                // Fallback for other formats
                const audio = new Audio();
                const audioBlob = this.base64ToBlob(audioData, 'audio/wav');
                const audioUrl = URL.createObjectURL(audioBlob);
                
                audio.src = audioUrl;
                audio.play().catch(error => {
                    console.error('Audio playback error:', error);
                });
            }
            
        } catch (error) {
            console.error('Audio creation error:', error);
        }
    }

    base64ToBlob(base64, mimeType) {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mimeType });
    }

    base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    addMessage(sender, text, type = 'user') {
        const conversationArea = document.getElementById('conversationArea');
        if (!conversationArea) {
            console.warn('conversationArea element not found');
            return;
        }
        
        const messageDiv = document.createElement('div');
        
        messageDiv.className = `mb-4 p-4 rounded-lg ${
            type === 'user' ? 'bg-blue-100 ml-8' : 
            type === 'agent' ? 'bg-green-100 mr-8' : 
            'bg-gray-100'
        }`;
        
        messageDiv.innerHTML = `
            <div class="font-semibold text-sm mb-1 text-gray-700">${sender}</div>
            <div class="text-gray-800">${text}</div>
        `;
        
        conversationArea.appendChild(messageDiv);
        conversationArea.scrollTop = conversationArea.scrollHeight;
    }

    showPartialTranscription(text) {
        console.log('Partial:', text);
    }

    updateMicButton() {
        const micBtn = document.getElementById('micBtn');
        if (!micBtn) return;
        
        const icon = micBtn.querySelector('i');
        
        if (this.isRecording) {
            micBtn.className = 'w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors';
            icon.className = 'fas fa-stop text-white text-xl';
        } else {
            micBtn.className = 'w-16 h-16 rounded-full bg-blue-500 hover:bg-blue-600 flex items-center justify-center transition-colors pulse-animation';
            icon.className = 'fas fa-microphone text-white text-xl';
        }
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connectionStatus');
        if (!statusElement) return;
        
        const dot = statusElement.querySelector('.w-3');
        const text = statusElement.querySelector('span');
        
        if (connected) {
            dot.className = 'w-3 h-3 rounded-full bg-green-400';
            text.textContent = 'Connected';
        } else {
            dot.className = 'w-3 h-3 rounded-full bg-red-400';  
            text.textContent = 'Disconnected';
        }
    }

    startCallTimer() {
        const callDurationElement = document.getElementById('callDuration');
        if (!callDurationElement) return;
        
        this.callStartTime = new Date();
        this.callDurationInterval = setInterval(() => {
            const duration = new Date() - this.callStartTime;
            const minutes = Math.floor(duration / 60000);
            const seconds = Math.floor((duration % 60000) / 1000);
            
            callDurationElement.textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    updateSessionInfo(data) {
        console.log('Session update:', data);
    }

    showError(message) {
        const errorElement = document.getElementById('loginError');
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.classList.remove('hidden');
            setTimeout(() => {
                errorElement.classList.add('hidden');
            }, 5000);
        } else {
            alert(message);
        }
    }

    async logout() {
        try {
            this.stopRecording();
            
            if (this.socket) {
                this.socket.close();
            }
            
            if (this.callDurationInterval) {
                clearInterval(this.callDurationInterval);
            }
            
            if (this.sessionId && this.token) {
                await fetch(`${this.config.apiUrl}/logout`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ session_id: this.sessionId })
                });
            }
            
            // Reset state
            this.isLoggedIn = false;
            this.token = null;
            this.sessionId = null;
            this.currentUser = null;
            
            // Clear form
            document.getElementById('username').value = '';
            document.getElementById('password').value = '';
            
            // Clear conversation
            const conversationArea = document.getElementById('conversationArea');
            if (conversationArea) {
                conversationArea.innerHTML = '';
            }
            
            this.showLogin();
            
        } catch (error) {
            console.error('Logout error:', error);
        }
    }
    
    showEndCallModal() {
        const modal = document.getElementById('endCallModal');
        if (modal) {
            modal.classList.remove('hidden');
        }
    }
    
    hideEndCallModal() {
        const modal = document.getElementById('endCallModal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }
    
    endCall() {
        // Close WebSocket connection
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        
        // Stop recording if active
        if (this.isRecording) {
            this.stopRecording();
        }
        
        // Hide modal
        this.hideEndCallModal();
        
        // Reset UI state
        this.resetCallState();
        
        // Show message
        this.addMessage('system', 'Call ended');
    }
    
    toggleMute() {
        this.isMuted = !this.isMuted;
        const muteBtn = document.getElementById('muteBtn');
        if (muteBtn) {
            if (this.isMuted) {
                muteBtn.textContent = 'Unmute';
                muteBtn.classList.remove('bg-gray-500', 'hover:bg-gray-600');
                muteBtn.classList.add('bg-green-500', 'hover:bg-green-600');
            } else {
                muteBtn.textContent = 'Mute';
                muteBtn.classList.remove('bg-green-500', 'hover:bg-green-600');
                muteBtn.classList.add('bg-gray-500', 'hover:bg-gray-600');
            }
        }
        
        // If recording, stop/start based on mute state
        if (this.isRecording && this.isMuted) {
            this.stopRecording();
        } else if (!this.isRecording && !this.isMuted && this.isConnected) {
            this.startRecording();
        }
    }
    
    resetCallState() {
        // Reset recording state
        this.isRecording = false;
        this.isMuted = false;
        
        // Update UI
        const micBtn = document.getElementById('micBtn');
        if (micBtn) {
            micBtn.classList.remove('bg-green-500');
            micBtn.classList.add('bg-red-500');
        }
        
        const muteBtn = document.getElementById('muteBtn');
        if (muteBtn) {
            muteBtn.textContent = 'Mute';
            muteBtn.classList.remove('bg-green-500', 'hover:bg-green-600');
            muteBtn.classList.add('bg-gray-500', 'hover:bg-gray-600');
        }
    }
}

// Initialize the app
let app;
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing app...');
    app = new SalesAgentApp();
    app.init();
});
