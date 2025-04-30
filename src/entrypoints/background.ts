import { ACTION } from "@/constants";
import { TranscriptSegment } from "@/interfaces";
import { convertTranscriptionToSpeechInUserLangugage } from "@/lib/convertTranscriptionToSpeech";

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });
  browser.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener(async (msg) => {
      if (msg.action === ACTION.START_AUDIO_STREAM) {
        const { transcription, language } = msg.payload as { transcription: TranscriptSegment[], language: string };

        console.log("transcription length", transcription.length);

        for (let i = 0; i < transcription.length; i++) {
          console.log("running for", i);
          try {
            const segment = transcription[i];
            const { audioContent } = await convertTranscriptionToSpeechInUserLangugage(segment.text, language);

            // Send chunk via port
            port.postMessage({
              type: ACTION.AUDIO_CHUNK,
              index: i,
              text: segment.text,
              audioContent,
            });
          } catch (err) {
            console.error(`Failed to generate audio for chunk ${i}:`, err);
            port.postMessage({
              type: ACTION.ERROR,
              index: i,
              error: "Audio generation failed",
            });
          }
        }

        // Signal end of stream
        port.postMessage({ type: ACTION.STREAM_COMPLETE });
      }
    });
  });
});
