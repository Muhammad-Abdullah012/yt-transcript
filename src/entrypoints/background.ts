import { ACTION } from "@/constants";
import { GEMINI_API_KEY } from "@/constants/keys";
import { TranscriptSegment } from "@/interfaces";
import { generateContentWithGemini } from "@/lib/callGemini";
import { convertTranscriptionToSpeechInUserLangugage } from "@/lib/convertTranscriptionToSpeech";
import { formatTranscript, parseTranscript } from "@/lib/scrapTranscript";

export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });
  browser.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener(async (msg) => {
      if (msg.action === ACTION.START_AUDIO_STREAM) {
        const { transcription, language } = msg.payload as { transcription: TranscriptSegment[], language: string };

        console.log("transcription length", transcription.length);
        const translated = await generateContentWithGemini(GEMINI_API_KEY, formatTranscript(transcription), language)
        console.log("translated", translated);
        const parsedTranslation = parseTranscript(translated)
        for (let i = 0; i < parsedTranslation.length; i++) {
          console.log("running for", i);
          try {
            const segment = parsedTranslation[i];
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
