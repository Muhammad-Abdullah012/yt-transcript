// background.ts
import { ACTION } from "@/constants";
import { GEMINI_API_KEY } from "@/constants/keys";
import { TranscriptSegment, SegmentAudioData } from "@/interfaces";
import { generateContentWithGemini } from "@/lib/callGemini";
import { convertTranscriptionToSpeechInUserLangugage } from "@/lib/convertTranscriptionToSpeech";
import { formatTranscript, parseTranscript } from "@/lib/scrapTranscript";
import { parseTimestampToSeconds } from "@/lib/utils";
import { audioBufferToWav } from "@/lib/audioBufferToWav"; // Import the utility

export default defineBackground(() => {
  const manifestVersion = browser.runtime.getManifest().manifest_version;
  console.log(`Background script loaded. Manifest Version: ${manifestVersion}`);

  // Store for chunks received via port connection (for download merging)
  const portAudioChunks = new Map<
    string,
    { index: number; text: string; audioContent: string }[]
  >();

  // --- AudioContext Handling (MV2 specific) ---
  let backgroundAudioContext: AudioContext | null = null;
  let isAudioContextAvailable: boolean | null = null; // null = undetermined, true/false = checked

  function getMV2BackgroundAudioContext(): AudioContext | null {
    if (manifestVersion !== 2) {
      if (isAudioContextAvailable === null) {
        console.log(
          "Running in MV3 (or unsupported env), AudioContext not directly available in background."
        );
        isAudioContextAvailable = false;
      }
      return null;
    }
    if (isAudioContextAvailable === false) return null;
    if (backgroundAudioContext && backgroundAudioContext.state !== "closed") {
      if (backgroundAudioContext.state === "suspended") {
        backgroundAudioContext
          .resume()
          .catch((err) =>
            console.error("Background failed to resume AudioContext:", err)
          );
      }
      return backgroundAudioContext;
    }
    try {
      console.log("Attempting to create AudioContext in MV2 background...");
      backgroundAudioContext = new AudioContext();
      console.log("Background AudioContext created successfully.");
      isAudioContextAvailable = true;
      return backgroundAudioContext;
    } catch (e) {
      console.error("******************************************************");
      console.error("Error creating AudioContext in background:", e);
      console.error(
        "Audio processing features (like download merge) may fail."
      );
      console.error("******************************************************");
      isAudioContextAvailable = false;
      backgroundAudioContext = null;
      return null;
    }
  }

  // --- Merging Logic (MV2 specific implementation) ---
  async function performMergeInMV2Background(
    base64Urls: string[]
  ): Promise<Blob> {
    const ctx = getMV2BackgroundAudioContext();
    if (!ctx) {
      throw new Error(
        "AudioContext is not available in the background script. Cannot merge audio."
      );
    }
    let targetSampleRate: number | null = null;
    let targetChannels: number | null = null;
    console.log(
      `Background (MV2) merging ${base64Urls.length} audio segments...`
    );
    try {
      const decodedBuffers: AudioBuffer[] = await Promise.all(
        base64Urls.map(async (url, index) => {
          try {
            const response = await fetch(url); // Fetch data URL
            if (!response.ok)
              throw new Error(
                `HTTP error fetching data URL! status: ${response.status}`
              );
            const arrayBuffer = await response.arrayBuffer();
            const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
            if (targetSampleRate === null) {
              targetSampleRate = decodedBuffer.sampleRate;
              targetChannels = decodedBuffer.numberOfChannels;
            } else if (
              decodedBuffer.sampleRate !== targetSampleRate ||
              decodedBuffer.numberOfChannels !== targetChannels
            ) {
              throw new Error(
                `Audio segment ${index} mismatch: Expected ${targetSampleRate}Hz/${targetChannels}ch, got ${decodedBuffer.sampleRate}Hz/${decodedBuffer.numberOfChannels}ch.`
              );
            }
            return decodedBuffer;
          } catch (error) {
            console.error(`Failed to decode audio segment ${index}:`, error);
            throw error;
          }
        })
      );
      if (
        decodedBuffers.length === 0 ||
        targetSampleRate === null ||
        targetChannels === null
      ) {
        throw new Error("No valid audio data to merge.");
      }
      const totalLength = decodedBuffers.reduce(
        (sum, buffer) => sum + buffer.length,
        0
      );
      const finalBuffer = ctx.createBuffer(
        targetChannels,
        totalLength,
        targetSampleRate
      );
      let currentOffset = 0;
      for (const buffer of decodedBuffers) {
        for (let channel = 0; channel < targetChannels; channel++) {
          if (channel < buffer.numberOfChannels) {
            finalBuffer.copyToChannel(
              buffer.getChannelData(channel),
              channel,
              currentOffset
            );
          } else {
            const silentData = new Float32Array(buffer.length).fill(0);
            finalBuffer.copyToChannel(silentData, channel, currentOffset);
          }
        }
        currentOffset += buffer.length;
      }
      const wavBlob = audioBufferToWav(finalBuffer);
      console.log(
        `Background (MV2) merge complete. Blob size: ${wavBlob.size}`
      );
      return wavBlob;
    } catch (error) {
      console.error("Error during background audio merging (MV2):", error);
      throw error;
    }
  }

  // --- Port Connection Handling ---
  browser.runtime.onConnect.addListener((port) => {
    // Use port name for identification, default if none provided
    const portId = port.name || `popup_port_${Date.now()}`;
    console.log(`Popup connected via port: ${portId}`);
    portAudioChunks.set(portId, []); // Initialize chunk storage for this connection

    port.onMessage.addListener(async (msg) => {
      // --- START_AUDIO_STREAM (for download prep) ---
      if (msg.action === ACTION.START_AUDIO_STREAM) {
        console.log(
          `[${portId}] Handling START_AUDIO_STREAM (for download prep)`
        );
        const { transcription, language } = msg.payload as {
          transcription: TranscriptSegment[];
          language: string;
        };
        const currentChunks: {
          index: number;
          text: string;
          audioContent: string;
        }[] = [];
        portAudioChunks.set(portId, []); // Clear previous chunks for this port/request

        try {
          const translated = await generateContentWithGemini(
            GEMINI_API_KEY,
            formatTranscript(transcription),
            language
          );
          const parsedTranslation = parseTranscript(translated);
          let generatedCount = 0;

          for (let i = 0; i < parsedTranslation.length && i <= 40; i++) {
            console.log(
              `[${portId}] Generating audio for download chunk ${i}/${parsedTranslation.length}`
            );
            const segment = parsedTranslation[i];
            const { audioContent } =
              await convertTranscriptionToSpeechInUserLangugage(
                segment.text,
                language,
                i
              );
            const chunkData = { index: i, text: segment.text, audioContent };
            currentChunks.push(chunkData);
            generatedCount++;
            // Send chunk immediately for potential progress update in popup
            port.postMessage({
              type: ACTION.AUDIO_CHUNK,
              index: i,
              total: parsedTranslation.length,
            });
          }
          // Store all chunks once generation is complete
          portAudioChunks.set(portId, currentChunks);
          console.log(
            `[${portId}] Finished generating ${generatedCount} chunks for download prep.`
          );
          port.postMessage({ type: ACTION.STREAM_COMPLETE });
        } catch (err: any) {
          console.error(`[${portId}] Failed during START_AUDIO_STREAM:`, err);
          port.postMessage({
            type: ACTION.ERROR,
            error: err.message || "Audio generation failed",
          });
          portAudioChunks.set(portId, []); // Clear chunks on error
        }
      }
      // --- MERGE_PORT_AUDIO (handles download request) ---
      else if (msg.action === ACTION.MERGE_PORT_AUDIO) {
        console.log(`[${portId}] Received MERGE_PORT_AUDIO request`);
        const chunks = portAudioChunks.get(portId);

        if (!chunks || chunks.length === 0) {
          console.warn(`[${portId}] No audio chunks found for merging.`);
          port.postMessage({
            type: ACTION.MERGE_AUDIO_RESULT,
            error:
              'No audio chunks available to merge. Please "Load Audio" first.',
          });
          return;
        }

        try {
          let mergedBlob: Blob | null = null;
          if (manifestVersion === 2) {
            if (isAudioContextAvailable === null)
              getMV2BackgroundAudioContext(); // Initial check if needed
            if (isAudioContextAvailable) {
              console.log(`[${portId}] Using MV2 background merging...`);
              chunks.sort((a, b) => a.index - b.index);
              mergedBlob = await performMergeInMV2Background(
                chunks.map((c) => c.audioContent)
              );
            } else {
              throw new Error(
                "AudioContext is not available in this background environment (MV2). Cannot merge."
              );
            }
          } else {
            // --- Placeholder for MV3 Offscreen Logic ---
            console.warn(
              "MV3 detected: Merging requires Offscreen Document (not implemented yet)."
            );
            throw new Error(
              "Audio merging for download is not yet supported in this browser version."
            );
            // mergedBlob = await delegateMergeToOffscreen(chunks.map(c => c.audioContent)); // Future
          }

          if (!mergedBlob)
            throw new Error("Merging process did not produce a result.");

          // Convert Blob to base64 data URL to send back
          const reader = new FileReader();
          reader.onloadend = () => {
            port.postMessage({
              type: ACTION.MERGE_AUDIO_RESULT,
              payload: reader.result as string,
            });
          };
          reader.onerror = (e) => {
            console.error(`[${portId}] Failed to read merged blob:`, e);
            port.postMessage({
              type: ACTION.MERGE_AUDIO_RESULT,
              error: "Failed to read merged blob.",
            });
          };
          reader.readAsDataURL(mergedBlob);
        } catch (error: any) {
          console.error(
            `[${portId}] Error handling MERGE_PORT_AUDIO request:`,
            error
          );
          port.postMessage({
            type: ACTION.MERGE_AUDIO_RESULT,
            error: error.message || "Merging failed.",
          });
        }
      }
    }); // End onMessage listener

    port.onDisconnect.addListener(() => {
      console.log(`Popup port ${portId} disconnected.`);
      portAudioChunks.delete(portId); // Clean up stored chunks for this specific connection
    });
  }); // End onConnect listener

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === ACTION.REQUEST_SYNC_AUDIO) {
      // Ensure it's from a content script
      if (!sender.tab) {
        console.warn(
          "Received REQUEST_SYNC_AUDIO from non-tab sender:",
          sender
        );
        return false; // Don't handle
      }
      const tabId = sender.tab.id;
      console.log(
        `Received REQUEST_SYNC_AUDIO from content script tab ${tabId}`
      );
      const { transcription, language } = message.payload as {
        transcription: TranscriptSegment[];
        language: string;
      };

      (async () => {
        try {
          console.log(`[Tab ${tabId}] Translating transcript for sync...`);
          const formatted = formatTranscript(transcription);
          const translated = await generateContentWithGemini(
            GEMINI_API_KEY,
            formatted,
            language
          );
          console.log(`[Tab ${tabId}] Parsing translated transcript...`);
          const parsedTranslation = parseTranscript(translated);

          if(parsedTranslation.length === transcription.length) {
            for (let i = 0; i < parsedTranslation.length; i++) {
              parsedTranslation[i].startTime = transcription[i].startTime;
              parsedTranslation[i].duration = transcription[i].duration;
            }
          } else {
            console.warn(
              `[Tab ${tabId}] Mismatch in segment count: ${parsedTranslation.length} translated vs ${transcription.length} original.`
            );
          }
          console.log(
            `[Tab ${tabId}] Generating TTS for ${parsedTranslation.length} sync segments...`
          );
          const audioDataPromises = parsedTranslation.map(
            async (segment, index) => {
              if(index > 40 ) return null; // Skip segments beyond 40 for testing
              try {
                // Find original segment to get correct start time, handle potential length mismatch
                const originalSegment =
                  transcription.find(
                    (orig, i) =>
                      i === index || orig.timestamp === segment.timestamp
                  ) ?? transcription[index];

                const startTime = originalSegment
                  ? originalSegment.startTime
                  : parseTimestampToSeconds(segment.timestamp); // Recalculate if needed
                if (!originalSegment)
                  console.warn(
                    `[Tab ${tabId}] Could not reliably match original segment for index ${index}, timestamp ${segment.timestamp}. Using calculated startTime.`
                  );

                const { audioContent } =
                  await convertTranscriptionToSpeechInUserLangugage(
                    segment.text,
                    language,
                    index
                  );
                return {
                  index,
                  text: segment.text,
                  audioContent,
                  startTime,
                  duration: segment.duration,
                } as SegmentAudioData;
              } catch (err) {
                console.error(
                  `[Tab ${tabId}] Failed to generate audio for sync segment ${index}:`,
                  err
                );
                return null;
              }
            }
          );

          const allAudioData = (await Promise.all(audioDataPromises)).filter(
            Boolean
          ) as SegmentAudioData[];

          if (allAudioData.length === 0 && parsedTranslation.length > 0) {
            throw new Error("Failed to generate any audio segments for sync.");
          }
          if (allAudioData.length < parsedTranslation.length) {
            console.warn(
              `[Tab ${tabId}] Some sync audio segments failed to generate.`
            );
          }

          console.log(
            `[Tab ${tabId}] Sending SYNC_AUDIO_READY (${allAudioData.length} segments) to content script`
          );
          if (!tabId) {
            console.error(
              `[Tab ${tabId}] Tab ID is not available for sending message.`
            );
            return;
          }
          browser.tabs.sendMessage(
            tabId,
            {
              action: ACTION.SYNC_AUDIO_READY,
              payload: allAudioData,
            },
            (response) => {
              console.log(
                `[Tab ${tabId}] sending SYNC_AUDIO_READY, response:`,
                response
              );
            }
          );
        } catch (error: any) {
          console.error(
            `[Tab ${tabId}] Error processing REQUEST_SYNC_AUDIO:`,
            error
          );
          if (!tabId) {
            console.error(
              `[Tab ${tabId}] Tab ID is not available for sending message.`
            );
            return;
          }
          browser.tabs.sendMessage(
            tabId,
            {
              action: ACTION.SYNC_AUDIO_FAILED,
              payload:
                error.message || "Unknown error during sync audio generation.",
            },
            (response) => {
              console.log(
                `[Tab ${tabId}] response sending SYNC_AUDIO_FAILED:`,
                response
              );
            }
          );
        }
      })();

      return false; // Indicates asynchronous response
    }
    // Handle other potential direct messages
    return false; // No async response expected for other messages
  }); // End onMessage listener

  // Initial check for AudioContext availability on load (for MV2)
  if (manifestVersion === 2) {
    getMV2BackgroundAudioContext();
  } else {
    isAudioContextAvailable = false; // Explicitly set for MV3
  }
}); // End defineBackground
