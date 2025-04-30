import { writable } from 'svelte/store';

export const audioQueueStore = writable<{ text: string; index: number }[]>([]);

export class AudioQueueManager {
    private queue: { audio: HTMLAudioElement; text: string }[] = [];
    private isPlaying = false;

    add(base64Data: string, text: string) {
        const audioUrl = `data:audio/wav;base64,${base64Data}`;
        const audio = new Audio(audioUrl);

        this.queue.push({ audio, text });
        this.updateStore();

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
        this.updateStore();

        current.audio.play().catch(err => {
            console.error("Playback failed:", err);
            this.playNext(); // Skip silently
        });

        current.audio.addEventListener("ended", () => {
            this.playNext();
        });
    }

    playIndividual(index: number) {
        if (index < 0 || index >= this.queue.length) {
            console.error("Invalid index for playback.");
            return;
        }

        const { audio } = this.queue[index];
        audio.play().catch(err => {
            console.error("Playback failed:", err);
        });
    }

    getQueue() {
        return this.queue.map(({ text }, index) => ({ text, index }));
    }

    private updateStore() {
        audioQueueStore.set(this.getQueue());
    }
}