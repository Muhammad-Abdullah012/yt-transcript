import { writable } from 'svelte/store';

export const individualAudioQueueStore = writable<{ text: string; index: number }[]>([]);

export type PlaybackState = 'playing' | 'paused' | 'stopped';
export const playbackStateStore = writable<PlaybackState>('stopped');

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
    private playbackQueue: { audio: HTMLAudioElement; text: string; url: string }[] = [];
    // Holds all segments received, for individual playback and merging
    private individualSegments: { audio: HTMLAudioElement; text: string; url: string }[] = [];
    // Tracks the currently playing item in the sequential queue
    private currentlyPlayingItem: { audio: HTMLAudioElement; text: string; url: string } | null = null;
    // Manages the overall playback state
    private playbackState: PlaybackState = 'stopped';

    // Create AudioContext lazily
    private _audioContext: AudioContext | null = null;
    private get audioContext(): AudioContext {
        if (!this._audioContext) {
            // Check if context exists and is running, otherwise create new
            if (typeof window !== 'undefined' && window.AudioContext) {
                 this._audioContext = new AudioContext();
            } else {
                // Handle environments where AudioContext might not be available (less likely in extension popup)
                console.error("AudioContext is not supported in this environment.");
                // Provide a dummy context or throw an error
                throw new Error("AudioContext not supported");
            }
        }
         // Handle suspended context (e.g., due to user interaction policy)
        if (this._audioContext.state === 'suspended') {
            this._audioContext.resume().catch(err => console.error("Failed to resume AudioContext:", err));
        }
        return this._audioContext;
    }

    // Helper to update state and notify store subscribers
    private setPlaybackState(newState: PlaybackState) {
        if (this.playbackState !== newState) {
            this.playbackState = newState;
            playbackStateStore.set(newState);
            console.log("Playback state changed to:", newState);
        }
    }

    /**
     * Adds a new audio segment (received as base64).
     * It's added to the list of individual segments and potentially to the playback queue
     * if playback is intended to start immediately or continue.
     * @param base64Data Base64 encoded WAV audio data.
     * @param text Associated transcript text.
     */
    add(base64Data: string, text: string) {
        const audioUrl = base64Data;
        const audio = new Audio(audioUrl);
        const newItem = { audio, text, url: audioUrl };

        // Add to the list for individual access and merging
        this.individualSegments.push(newItem);
        individualAudioQueueStore.set(this.getIndividualQueue()); // Update UI store

        // Add to the queue for sequential playback
        this.playbackQueue.push(newItem);

        // If playback was requested and is currently stopped/finished,
        // but now has items, start playing the next one.
        // Note: Actual playback start is now controlled by play() method.
        // This ensures adding items doesn't auto-start if paused.
        if (this.playbackState === 'playing' && !this.currentlyPlayingItem) {
             this.playNextInternal();
        }
    }

    /**
     * Starts or resumes sequential playback of the main queue.
     */
    play() {
        if (this.playbackState === 'playing') {
            console.log("Already playing.");
            return; // Already playing
        }

        // If paused and there's an item currently paused, resume it
        if (this.playbackState === 'paused' && this.currentlyPlayingItem) {
            this.currentlyPlayingItem.audio.play().then(() => {
                 this.setPlaybackState('playing');
            }).catch(err => {
                console.error("Resume failed:", err);
                // Attempt to play the next item if resume fails
                this.currentlyPlayingItem = null; // Clear failed item
                this.setPlaybackState('playing'); // Set state before calling next
                this.playNextInternal();
            });
        } else {
            // If stopped or paused without a current item, start from the beginning of the queue
            this.setPlaybackState('playing');
            this.playNextInternal();
        }
    }

    /**
     * Pauses sequential playback of the main queue.
     */
    pause() {
        if (this.playbackState !== 'playing') {
            console.log("Not playing, cannot pause.");
            return; // Not playing or already paused/stopped
        }

        if (this.currentlyPlayingItem) {
            this.currentlyPlayingItem.audio.pause();
            this.setPlaybackState('paused');
        } else {
            // Pausing between tracks - just change state
             this.setPlaybackState('paused');
        }
    }

    /**
     * Stops playback entirely and resets the main playback queue position.
     * Keeps the individual segments available.
     */
    stop() {
        if (this.currentlyPlayingItem) {
            this.currentlyPlayingItem.audio.pause();
            this.currentlyPlayingItem.audio.currentTime = 0; // Reset time
            this.currentlyPlayingItem = null;
        }
        // Don't clear the playbackQueue here if we want 'play' to restart from beginning
        // If stop should prevent restart, clear it: this.playbackQueue = [];
        this.setPlaybackState('stopped');
    }


    /**
     * Internal method to play the next item in the playbackQueue.
     * Should only be called when playbackState is 'playing'.
     */
    private playNextInternal() {
        // Ensure we are in the correct state to proceed
        if (this.playbackState !== 'playing') {
            console.log("playNextInternal called but state is not 'playing'. Aborting.");
            return;
        }

        // If something is already marked as playing, wait for it to finish
        if (this.currentlyPlayingItem) {
            console.log("playNextInternal called while an item is already playing. Waiting.");
            return;
        }

        if (this.playbackQueue.length === 0) {
            console.log("Playback queue finished.");
            this.setPlaybackState('stopped');
            this.currentlyPlayingItem = null;
            return;
        }

        this.currentlyPlayingItem = this.playbackQueue.shift()!;
        const current = this.currentlyPlayingItem;

        // --- Event Listeners ---
        const onEnded = () => {
            console.log(`Segment ended: "${current.text}"`);
            cleanupListeners();
            this.currentlyPlayingItem = null;
            // IMPORTANT: Only proceed if still in 'playing' state
            if (this.playbackState === 'playing') {
                this.playNextInternal();
            }
        };

        const onError = (e: Event | string) => {
            console.error(`Audio error for segment "${current.text}":`, e);
            cleanupListeners();
            this.currentlyPlayingItem = null;
            // Skip failed item and try next, only if playing
            if (this.playbackState === 'playing') {
                 this.playNextInternal();
            } else {
                // If an error occurs while paused/stopped, just stop
                this.setPlaybackState('stopped');
            }
        };

        const cleanupListeners = () => {
            current.audio.removeEventListener("ended", onEnded);
            current.audio.removeEventListener("error", onError);
        };

        current.audio.addEventListener("ended", onEnded);
        current.audio.addEventListener("error", onError);
        // --- End Event Listeners ---


        console.log(`Playing segment: "${current.text}"`);
        current.audio.play().catch(err => {
            console.error(`Initial playback failed for "${current.text}":`, err);
            onError(err.toString()); // Trigger error handling
        });
    }

    /**
     * Plays a specific individual audio segment by its index in the `individualSegments` array.
     * This does NOT affect the main sequential playback queue/state.
     * @param index The index of the segment in the `individualSegments` array.
     */
    playIndividual(index: number) {
        if (index < 0 || index >= this.individualSegments.length) {
            console.error("Invalid index for individual playback.");
            return;
        }
        // Pause the main queue playback if it's running
        if (this.playbackState === 'playing') {
            this.pause();
        }
        // Pause any other potentially playing individual segment (simple approach)
        this.individualSegments.forEach((seg, i) => {
            if (i !== index && !seg.audio.paused) {
                seg.audio.pause();
                seg.audio.currentTime = 0; // Optional: reset others
            }
        });

        const { audio } = this.individualSegments[index];
        audio.currentTime = 0; // Start from beginning
        audio.play().catch(err => {
            console.error("Individual playback failed:", err);
        });
    }

    /**
     * Pauses a specific individual audio segment.
     * @param index The index of the segment in the `individualSegments` array.
     */
    pauseIndividual(index: number): void {
        if (index < 0 || index >= this.individualSegments.length) {
            console.error("Invalid index for pausing individual segment.");
            return;
        }
        const { audio } = this.individualSegments[index];
        if (!audio.paused) {
            audio.pause();
        }
    }

    /**
     * Gets the list of individual segments (text and index) for UI display.
     */
    getIndividualQueue() {
        return this.individualSegments.map(({ text }, index) => ({ text, index }));
    }

    /**
     * Checks if any audio segments have been loaded.
     */
    hasAnyAudio(): boolean {
        return this.individualSegments.length > 0;
    }

    /**
     * Merges all individual audio segments into a single, valid WAV Blob
     * using the Web Audio API.
     * @returns A Promise resolving to a Blob containing the merged WAV audio.
     */
    async getFullAudio(): Promise<Blob> {
        if (this.individualSegments.length === 0) {
            console.warn("No audio segments in the queue to merge.");
            return new Blob([], { type: 'audio/wav' });
        }

        // Ensure AudioContext is available and resumed
        const ctx = this.audioContext;
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }

        let targetSampleRate: number | null = null;
        let targetChannels: number | null = null;

        try {
            // 1. Decode all audio segments into AudioBuffers
            const decodedBuffers: AudioBuffer[] = await Promise.all(
                this.individualSegments.map(async (item) => {
                    try {
                        // Use cached data URL directly
                        const response = await fetch(item.url);
                        if (!response.ok) {
                            throw new Error(`HTTP error fetching data URL! status: ${response.status}`);
                        }
                        const arrayBuffer = await response.arrayBuffer();
                        const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

                        // --- Validation ---
                        if (targetSampleRate === null) {
                            targetSampleRate = decodedBuffer.sampleRate;
                            targetChannels = decodedBuffer.numberOfChannels;
                        } else if (decodedBuffer.sampleRate !== targetSampleRate || decodedBuffer.numberOfChannels !== targetChannels) {
                            console.error(`Audio segment mismatch: Expected ${targetSampleRate}Hz/${targetChannels}ch, got ${decodedBuffer.sampleRate}Hz/${decodedBuffer.numberOfChannels}ch for text: "${item.text}". Merging may fail or produce unexpected results.`);
                            throw new Error("Audio segments have incompatible sample rates or channel counts.");
                        }
                        // ---------------

                        return decodedBuffer;
                    } catch (error) {
                        console.error(`Failed to decode audio for text "${item.text}":`, error);
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
            // Use targetChannels and targetSampleRate derived during decoding
            const finalBuffer = ctx.createBuffer(targetChannels, totalLength, targetSampleRate);

            // 3. Copy data from each decoded buffer into the final buffer
            let currentOffset = 0;
            for (const buffer of decodedBuffers) {
                for (let channel = 0; channel < targetChannels; channel++) {
                    // Ensure the source buffer actually has the channel data
                    if (channel < buffer.numberOfChannels) {
                         finalBuffer.copyToChannel(buffer.getChannelData(channel), channel, currentOffset);
                    } else {
                        // Handle potential channel mismatch (though validation should prevent this)
                        // Fill with silence or duplicate channel? Filling with silence is safer.
                        const silentData = new Float32Array(buffer.length).fill(0);
                        finalBuffer.copyToChannel(silentData, channel, currentOffset);
                    }
                }
                currentOffset += buffer.length;
            }

            // 4. Encode the final AudioBuffer to a WAV Blob
            const wavBlob = audioBufferToWav(finalBuffer);
            return wavBlob;

        } catch (error) {
            console.error("Error processing audio for getFullAudio:", error);
            return new Blob([], { type: 'audio/wav' }); // Return empty blob on error
        }
    }

    /**
     * Clears all audio segments, stops playback, and resets state.
     */
    clearAllAudio() {
        console.log("Clearing all audio...");
        this.stop(); // Stop current playback and set state to 'stopped'

        // Pause and release resources for all individual segments
        this.individualSegments.forEach(({ audio }) => {
            if (!audio.paused) {
                audio.pause();
            }
            audio.removeAttribute('src'); // Remove source
            audio.load(); // Reset element state
        });

        // Clear internal arrays
        this.playbackQueue = [];
        this.individualSegments = [];
        this.currentlyPlayingItem = null;

        // Update stores
        individualAudioQueueStore.set([]);
        // Ensure playback state is stopped (should be set by this.stop(), but belt-and-suspenders)
        this.setPlaybackState('stopped');

        // Optional: Close AudioContext if absolutely sure it won't be needed again soon.
        // Generally better to keep it open unless the extension is being unloaded.
        // if (this._audioContext && this._audioContext.state !== 'closed') {
        //     this._audioContext.close().then(() => {
        //         console.log("AudioContext closed.");
        //         this._audioContext = null;
        //     }).catch(err => console.error("Error closing AudioContext:", err));
        // }
    }
}