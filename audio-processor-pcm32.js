// PCM32 Audio Processor for low-latency audio streaming
class PCM32AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 512; // Small buffer for low latency (32ms at 16kHz)
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        this.sampleRate = 16000; // Target sample rate for Vosk
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        
        if (input.length > 0) {
            const inputChannel = input[0];
            
            for (let i = 0; i < inputChannel.length; i++) {
                this.buffer[this.bufferIndex++] = inputChannel[i];
                
                // Send when buffer is full
                if (this.bufferIndex >= this.bufferSize) {
                    // Convert Float32 (-1 to 1) to PCM16 (-32768 to 32767)
                    const pcm16 = new Int16Array(this.bufferSize);
                    for (let j = 0; j < this.bufferSize; j++) {
                        // Clamp and convert to 16-bit PCM
                        const sample = Math.max(-1, Math.min(1, this.buffer[j]));
                        pcm16[j] = Math.round(sample * 32767);
                    }
                    
                    // Send binary data to main thread
                    this.port.postMessage({
                        type: 'audioData',
                        data: pcm16.buffer,
                        sampleRate: this.sampleRate,
                        samples: this.bufferSize,
                        timestamp: currentTime
                    });
                    
                    this.bufferIndex = 0;
                }
            }
        }
        
        return true;
    }

    static get parameterDescriptors() {
        return [];
    }
}

registerProcessor('pcm32-audio-processor', PCM32AudioProcessor);
