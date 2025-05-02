import { writable } from 'svelte/store';

export const individualAudioQueueStore = writable<{ text: string; index: number }[]>([]);

// Helper function to encode AudioBuffer to WAV Blob
// Based on: https://github.com/mattdiamond/Recorderjs/blob/master/src/recorderWorker.js (exportWAV logic)
// and https://docs.fileformat.com/audio/wav/
function audioBufferToWav(buffer: AudioBuffer): Blob {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44; // 2 bytes per sample
    const bufferArr = new ArrayBuffer(length);
    const view = new DataView(bufferArr);
    const channels: Float32Array[] = [];
    let i: number;
    let sample: number;
    let offset = 0;
    let pos = 0;

    // Write WAV container
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    // Write FMT chunk
    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(buffer.sampleRate);
    setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit (hardcoded in this implementation)

    // Write Data chunk
    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    // Write the PCM samples
    for (i = 0; i < buffer.numberOfChannels; i++) {
        channels.push(buffer.getChannelData(i));
    }

    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            // Interleave channels
            sample = Math.max(-1, Math.min(1, channels[i][offset])); // Clamp
            // Scale to 16-bit signed int
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767);
            view.setInt16(pos, sample, true); // Write 16-bit sample
            pos += 2;
        }
        offset++; // Next frame
    }

    return new Blob([bufferArr], { type: 'audio/wav' });

    function setUint16(data: number) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data: number) {
        view.setUint32(pos, data, true);
        pos += 4;
    }
}


export class AudioQueueManager {
    private queue: { audio: HTMLAudioElement; text: string; url: string }[] = [];
    private individualQueue: { audio: HTMLAudioElement; text: string; url: string }[] = [];
    private isPlaying = false;
    // Create AudioContext lazily
    private _audioContext: AudioContext | null = null;

    private get audioContext(): AudioContext {
        if (!this._audioContext) {
            this._audioContext = new AudioContext();
        }
        return this._audioContext;
    }

    add(base64Data: string, text: string) {
        const audioUrl = `data:audio/wav;base64,${base64Data}`;
        const audio = new Audio(audioUrl);
        const item = { audio, text, url: audioUrl };

        this.queue.push(item);
        this.individualQueue.push(item);
        individualAudioQueueStore.set(this.getIndividualQueue());

        if (!this.isPlaying) {
            this.playNext();
        }
    }

    playNext() {
        if (this.queue.length === 0) {
            this.isPlaying = false;
            return;
        }

        this.isPlaying = true;
        const current = this.queue.shift()!;

        current.audio.play().catch(err => {
            console.error("Playback failed:", err);
            this.playNext(); // Skip silently
        });

        current.audio.addEventListener("ended", () => {
            this.playNext();
        });

        current.audio.addEventListener("error", (e) => {
            console.error("Audio error:", e);
            this.playNext(); // Skip on error
        });
    }

    playIndividual(index: number) {
        if (index < 0 || index >= this.individualQueue.length) {
            console.error("Invalid index for playback.");
            return;
        }
        const { audio } = this.individualQueue[index];
        audio.currentTime = 0;
        audio.play().catch(err => {
            console.error("Individual playback failed:", err);
        });
    }

    getQueue() {
        return this.queue.map(({ text }, index) => ({ text, index }));
    }

    getIndividualQueue() {
        return this.individualQueue.map(({ text }, index) => ({ text, index }));
    }

    hasAnyAudio(): boolean {
        return this.individualQueue.length > 0;
    }

    /**
     * Merges all individual audio segments into a single, valid WAV Blob
     * using the Web Audio API.
     * @returns A Promise resolving to a Blob containing the merged WAV audio.
     */
    async getFullAudio(): Promise<Blob> {
        if (this.individualQueue.length === 0) {
            console.warn("No audio segments in the queue to merge.");
            return new Blob([], { type: 'audio/wav' });
        }

        const ctx = this.audioContext;
        let targetSampleRate: number | null = null;
        let targetChannels: number | null = null;

        try {
            // 1. Decode all audio segments into AudioBuffers
            const decodedBuffers: AudioBuffer[] = await Promise.all(
                this.individualQueue.map(async (item) => {
                    try {
                        const response = await fetch(item.url);
                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        const arrayBuffer = await response.arrayBuffer();
                        const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

                        // --- Validation ---
                        if (targetSampleRate === null) {
                            targetSampleRate = decodedBuffer.sampleRate;
                            targetChannels = decodedBuffer.numberOfChannels;
                        } else if (decodedBuffer.sampleRate !== targetSampleRate || decodedBuffer.numberOfChannels !== targetChannels) {
                            // Handle mismatch - either resample (complex) or throw error
                            console.error(`Audio segment mismatch: Expected ${targetSampleRate}Hz/${targetChannels}ch, got ${decodedBuffer.sampleRate}Hz/${decodedBuffer.numberOfChannels}ch for text: "${item.text}". Merging may fail or produce unexpected results.`);
                            // For simplicity, we'll throw an error here. Resampling is beyond scope.
                            throw new Error("Audio segments have incompatible sample rates or channel counts.");
                        }
                        // ---------------

                        return decodedBuffer;
                    } catch (error) {
                        console.error(`Failed to fetch or decode audio for text "${item.text}":`, error);
                        throw error; // Re-throw to fail Promise.all if one segment fails
                    }
                })
            );

            if (decodedBuffers.length === 0 || targetSampleRate === null || targetChannels === null) {
                 console.warn("No valid audio buffers could be decoded.");
                 return new Blob([], { type: 'audio/wav' });
            }

            // 2. Calculate total length and create the final buffer
            const totalLength = decodedBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
            const finalBuffer = ctx.createBuffer(targetChannels, totalLength, targetSampleRate);

            // 3. Copy data from each decoded buffer into the final buffer
            let currentOffset = 0;
            for (const buffer of decodedBuffers) {
                for (let channel = 0; channel < targetChannels; channel++) {
                    finalBuffer.copyToChannel(buffer.getChannelData(channel), channel, currentOffset);
                }
                currentOffset += buffer.length;
            }

            // 4. Encode the final AudioBuffer to a WAV Blob
            const wavBlob = audioBufferToWav(finalBuffer);
            return wavBlob;

        } catch (error) {
            console.error("Error processing audio for getFullAudio:", error);
            // Return empty blob or re-throw, depending on desired error handling
            return new Blob([], { type: 'audio/wav' });
        }
    }

    pauseIndividual(index: number): void {
        if (index < 0 || index >= this.individualQueue.length) {
            console.error("Invalid index for pausing.");
            return;
        }
        const { audio } = this.individualQueue[index];
        if (!audio.paused) {
            audio.pause();
        }
    }

    clearAllAudio() {
        // Stop current playback if any
        if (this.isPlaying && this.queue.length > 0) {
            // Find the currently playing audio element to pause it
            // This requires tracking the *currently playing* element, which isn't explicitly done here.
            // A simpler approach is to just clear the queues and let the ended event handle itself.
        }
        this.queue = [];
        this.isPlaying = false;

        this.individualQueue.forEach(({ audio }) => {
            audio.pause();
            // Revoke object URL if it was created, but here we use data URLs
            audio.removeAttribute('src'); // Helps release resources
            audio.load(); // Resets the media element
        });
        this.individualQueue = [];
        individualAudioQueueStore.set([]); // Update the store
        this.isPlaying = false;

        // Optional: Close AudioContext if no longer needed (can save resources)
        // Be careful, once closed, it cannot be reopened. Only do this if you are sure.
        // if (this._audioContext) {
        //     this._audioContext.close().catch(console.error);
        //     this._audioContext = null;
        // }
    }
}