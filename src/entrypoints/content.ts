import { ACTION } from "@/constants";
import type {
  TranscriptSegment,
  SegmentAudioData,
  SyncStatus,
} from "@/interfaces";
import { clickTranscriptButton, scrapeTranscript } from "@/lib/scrapTranscript";
import { findSegmentIndexForTime } from "@/lib/utils";

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*"],
  runAt: "document_idle",
  main() {
    console.log("YT Sync Content Script Loaded");

    let videoElement: HTMLVideoElement | null = null;
    let audioElement: HTMLAudioElement | null = null;
    let transcriptData: TranscriptSegment[] | null = null;
    let syncAudioData: SegmentAudioData[] | null = null;
    let audioBlobUrls: Map<number, string> = new Map();
    let isSyncActive = false;
    let currentSegmentIndex = -1;
    let isAudioPlaying = false;

    function initializeSyncComponents() {
      console.log("initializeSyncComponents function called!");
      if (!audioElement) {
        audioElement = document.createElement("audio");
        audioElement.style.display = "none";
        audioElement.preload = "auto";
        document.body.appendChild(audioElement);
        console.log("Audio element created for sync playback.");
        audioElement.addEventListener("ended", handleAudioEnded);
        audioElement.addEventListener("error", handleAudioError);
        audioElement.addEventListener("stalled", () => {
          console.warn(`Audio stalled for segment ${currentSegmentIndex}`);
          isAudioPlaying = false;
        });
        audioElement.addEventListener("play", () => {
          isAudioPlaying = true;
          console.log(`Audio started playing for segment ${currentSegmentIndex}`);
        });
        audioElement.addEventListener("pause", () => {
          isAudioPlaying = false;
          console.log(`Audio paused for segment ${currentSegmentIndex}`);
        });
      }
      findVideoElement();
    }

    function playAudio(a: HTMLAudioElement) {
      console.log("playAudio function called!");
      if (videoElement && !videoElement.muted) {
        const muteButton = document.querySelector(
          `button.ytp-button[aria-label*="Mute"]`
        ) as HTMLButtonElement;
        if (muteButton) {
          muteButton.click();
          console.log("Video muted to avoid sound interference.");
        } else {
          console.log("muteButton not found");
        }
      }
      return a.play();
    }

    function findVideoElement() {
      console.log("findVideoElement function called!");
      if (!videoElement || !document.body.contains(videoElement)) {
        videoElement = document.querySelector("video");
        if (videoElement) {
          console.log("Video element found.");
          attachVideoListeners();
        } else {
          console.warn("Could not find video element on init.");
        }
      }
    }

    function cleanupResources() {
      console.log("Cleaning up content script resources...");
      stopSync();
      detachVideoListeners();
      cleanupBlobUrls();
      if (audioElement) {
        audioElement.removeEventListener("ended", handleAudioEnded);
        audioElement.removeEventListener("error", handleAudioError);
        audioElement.removeEventListener("stalled", () => {});
        audioElement.removeEventListener("play", () => {});
        audioElement.removeEventListener("pause", () => {});
        audioElement.remove();
        audioElement = null;
      }
      if (videoElement) {
        videoElement.playbackRate = 1.0;
      }
      videoElement = null;
      transcriptData = null;
      syncAudioData = null;
    }

    function cleanupBlobUrls() {
      console.log("Cleaning up Blob URLs...");
      if (audioBlobUrls.size > 0) {
        console.log(`Revoking ${audioBlobUrls.size} Blob URLs...`);
        audioBlobUrls.forEach((url, index) => {
          if (Math.abs(index - currentSegmentIndex) > 2) {
            URL.revokeObjectURL(url);
            audioBlobUrls.delete(index);
          }
        });
      }
    }

    function startSync() {
      console.log("startSync() function called!");
      findVideoElement();
      if (!videoElement || !syncAudioData || syncAudioData.length === 0) {
        console.error("Cannot start sync: Video element or audio data missing.");
        sendStatusUpdate({
          state: "error",
          message: "Missing video or audio data.",
        });
        return;
      }

      console.log("Starting synchronized playback...");
      isSyncActive = true;
      initializeSyncComponents();
      attachVideoListeners();

      const currentTime = videoElement.currentTime;
      const targetIndex = findSegmentIndexForTime(currentTime, syncAudioData);

      if (targetIndex < 0) {
        console.error("No valid segment found for current time.");
        sendStatusUpdate({
          state: "error",
          message: "No valid segment found for current time.",
        });
        return;
      }

      if (videoElement.paused) {
        console.log("Sync started while video paused.");
        prepareSegment(targetIndex, false);
        sendStatusUpdate({ state: "paused", segmentIndex: targetIndex });
      } else {
        console.log("Sync started while video playing.");
        const offset = currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);
        playSegment(targetIndex, offset);
        sendStatusUpdate({ state: "playing", segmentIndex: targetIndex });
      }
    }

    function stopSync() {
      if (!isSyncActive) return;
      console.log("Stopping synchronized playback...");
      isSyncActive = false;
      if (audioElement) {
        audioElement.pause();
        audioElement.removeAttribute("src");
        audioElement.playbackRate = 1.0;
      }
      if (videoElement) {
        videoElement.playbackRate = 1.0;
      }
      currentSegmentIndex = -1;
      isAudioPlaying = false;
      cleanupBlobUrls();
      sendStatusUpdate({ state: "stopped" });
    }

    async function prepareSegment(
      index: number,
      shouldPlay: boolean,
      playOffset: number = 0
    ): Promise<boolean> {
      if (videoElement) {
        videoElement.playbackRate = 1.0;
      }
      if (
        !syncAudioData ||
        index < 0 ||
        index >= syncAudioData.length ||
        !audioElement
      ) {
        console.log(
          `Cannot prepare segment: Invalid index ${index} or missing data/element.`
        );
        if (audioElement && !audioElement.paused) audioElement.pause();
        currentSegmentIndex = -1;
        isAudioPlaying = false;
        return false;
      }

      const segment = syncAudioData[index];
      const segmentIdentifier = `Seg ${index} (${segment.startTime.toFixed(1)}s)`;

      // Avoid replaying the same segment if it's still valid and playing
      if (
        currentSegmentIndex === index &&
        audioElement.currentSrc &&
        isAudioPlaying &&
        !audioElement.paused &&
        !audioElement.ended &&
        Math.abs(audioElement.currentTime - playOffset) < 0.5
      ) {
        console.log(`${segmentIdentifier} already playing correctly.`);
        if (!shouldPlay && !audioElement.paused) {
          audioElement.pause();
          isAudioPlaying = false;
        }
        return true;
      }

      // Load new segment
      currentSegmentIndex = index;
      let blobUrl = audioBlobUrls.get(index);
      let retryCount = 0;
      const maxRetries = 3;

      // Reset audio element state
      audioElement.pause();
      audioElement.removeAttribute("src");
      audioElement.playbackRate = 1.0;

      while (!blobUrl && retryCount <= maxRetries) {
        try {
          const base64Response = await fetch(segment.audioContent);
          if (!base64Response.ok)
            throw new Error(`Failed to fetch base64 data URL: ${base64Response.status}`);
          const blob = await base64Response.blob();

          // Validate blob type
          if (!blob.type.startsWith("audio/")) {
            throw new Error(`Invalid blob type: ${blob.type}`);
          }

          // Test decode audio
          const testAudio = new Audio(URL.createObjectURL(blob));
          const decodePromise = new Promise((resolve, reject) => {
            testAudio.addEventListener("loadedmetadata", () => resolve(true), { once: true });
            testAudio.addEventListener("error", () => reject(new Error("Test decode failed")), { once: true });
          });
          await decodePromise;
          testAudio.src = ""; // Clean up test audio

          blobUrl = URL.createObjectURL(blob);
          audioBlobUrls.set(index, blobUrl);
        } catch (e) {
          console.error(`Error creating Blob URL for ${segmentIdentifier} (Attempt ${retryCount + 1}):`, e);
          retryCount++;
          if (retryCount > maxRetries) {
            handleAudioError(`Blob creation or decode failed after ${maxRetries} retries for ${segmentIdentifier}`, segmentIdentifier);
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      audioElement.src = blobUrl!;

      // Preload next segment
      if (index + 1 < syncAudioData.length && !audioBlobUrls.has(index + 1)) {
        const nextSegment = syncAudioData[index + 1];
        fetch(nextSegment.audioContent)
          .then((res) => {
            if (!res.ok) throw new Error(`Failed to preload segment ${index + 1}`);
            return res.blob();
          })
          .then((blob) => {
            audioBlobUrls.set(index + 1, URL.createObjectURL(blob));
            console.log(`Preloaded Blob URL for segment ${index + 1}`);
          })
          .catch((e) => console.warn(`Failed to preload segment ${index + 1}:`, e));
      }

      // Clean up old Blob URLs
      cleanupBlobUrls();

      const handleAudioMetadataLoaded = () => {
        if (!audioElement) return;
        const audioDuration = audioElement.duration;
        const targetDuration = segment.duration;

        console.log(`Metadata for ${segmentIdentifier}: duration=${audioDuration}s, target=${targetDuration}s`);

        const videoRate = audioDuration / targetDuration;
        const boundedVideoRate = Math.min(Math.max(videoRate, 0.5), 2.0);
        console.log(
          `Adjusted video playback rate: ${boundedVideoRate.toFixed(2)} (raw: ${videoRate.toFixed(2)})`
        );

        if (videoElement && !isNaN(boundedVideoRate) && isFinite(boundedVideoRate)) {
          videoElement.playbackRate = boundedVideoRate;
        } else {
          console.warn(`Invalid video playback rate: ${videoRate}, resetting to 1.0`);
          if (videoElement) videoElement.playbackRate = 1.0;
        }

        if (shouldPlay) {
          const playPromise = playAudio(audioElement);
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                if (playOffset > 0.1) {
                  try {
                    audioElement!.currentTime = playOffset;
                  } catch (e) {
                    console.error(`Failed to set audio currentTime:`, e);
                  }
                }
              })
              .catch((err) => {
                handleAudioError(err, segmentIdentifier);
                console.warn(`${segmentIdentifier} failed to play automatically.`);
                if (!audioElement?.paused) audioElement?.pause();
                isAudioPlaying = false;
              });
          } else {
            console.warn(`${segmentIdentifier} play() did not return a promise.`);
            if (!audioElement.paused) {
              audioElement.pause();
              isAudioPlaying = false;
            }
          }
        } else {
          audioElement.pause();
          isAudioPlaying = false;
        }
      };

      const metadataTimeout = setTimeout(() => {
        console.error(`Metadata load timeout for ${segmentIdentifier}`);
        handleAudioError(`Metadata load timeout for ${segmentIdentifier}`, segmentIdentifier);
      }, 10000);

      audioElement.addEventListener("loadedmetadata", () => {
        clearTimeout(metadataTimeout);
        handleAudioMetadataLoaded();
      }, { once: true });

      audioElement.load();
      return true;
    }

    function playSegment(index: number, offset: number = 0) {
      prepareSegment(index, true, offset);
    }

    function handleVideoPlay() {
      console.log("handleVideoPlay function called!");
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      console.log("Video Play Event");

      const currentTime = videoElement.currentTime;
      const targetIndex = findSegmentIndexForTime(currentTime, syncAudioData);
      const offset = currentTime - (syncAudioData[targetIndex]?.startTime ?? currentTime);

      if (
        targetIndex === currentSegmentIndex &&
        audioElement &&
        isAudioPlaying &&
        !audioElement.paused &&
        !audioElement.ended &&
        Math.abs(audioElement.currentTime - offset) < 0.5
      ) {
        console.log(`Segment ${currentSegmentIndex} already playing correctly.`);
        return;
      }

      if (
        targetIndex === currentSegmentIndex &&
        audioElement &&
        audioElement.currentSrc &&
        !audioElement.ended
      ) {
        console.log(`Resuming segment ${currentSegmentIndex} at offset ${offset.toFixed(2)}s`);
        try {
          if (Math.abs(audioElement.currentTime - Math.max(0, offset)) > 0.1) {
            audioElement.currentTime = Math.max(0, offset);
          }
          playAudio(audioElement).catch((err) =>
            handleAudioError(err, `Seg ${currentSegmentIndex}`)
          );
        } catch (e) {
          console.error("Error resuming audio:", e);
          playSegment(targetIndex, offset);
        }
      } else {
        console.log(`Video played, starting segment ${targetIndex} at offset ${offset.toFixed(2)}s`);
        playSegment(targetIndex, offset);
      }
      sendStatusUpdate({ state: "playing", segmentIndex: currentSegmentIndex });
    }

    function handleVideoPause() {
      console.log("handleVideoPause function called!");
      if (!isSyncActive || !audioElement) return;
      console.log("Video Pause Event");
      if (!audioElement.paused) {
        audioElement.pause();
        console.log(`Audio paused for segment ${currentSegmentIndex}`);
      }
      sendStatusUpdate({ state: "paused", segmentIndex: currentSegmentIndex });
    }

    function handleVideoSeeked() {
      console.log("handleVideoSeeked function called!");
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      const newTime = videoElement.currentTime;
      console.log(`Video Seeked Event to ${newTime.toFixed(2)}s`);

      const targetIndex = findSegmentIndexForTime(newTime, syncAudioData);
      const offset = newTime - (syncAudioData[targetIndex]?.startTime ?? newTime);

      console.log(`Seeking audio to segment ${targetIndex} at offset ${offset.toFixed(2)}s`);

      if (!videoElement.paused) {
        playSegment(targetIndex, offset);
        sendStatusUpdate({ state: "playing", segmentIndex: targetIndex });
      } else {
        prepareSegment(targetIndex, false);
        if (audioElement && !audioElement.paused) audioElement.pause();
        sendStatusUpdate({ state: "paused", segmentIndex: targetIndex });
      }
    }

    function handleAudioEnded() {
      console.log("handleAudioEnded function called!");
      if (!isSyncActive || !videoElement || !syncAudioData) return;
      const endedSegmentIndex = currentSegmentIndex;
      console.log(`Audio ended for segment ${endedSegmentIndex}`);

      if (videoElement.paused) {
        console.log("Video is paused, not playing next segment automatically.");
        sendStatusUpdate({ state: "paused", segmentIndex: endedSegmentIndex });
        return;
      }

      // Try the next sequential segment
      let nextIndex = endedSegmentIndex + 1;
      if (nextIndex < syncAudioData.length) {
        const nextSegment = syncAudioData[nextIndex];
        const offset = Math.max(0, videoElement.currentTime - nextSegment.startTime);
        console.log(`Playing next segment ${nextIndex} at offset ${offset.toFixed(2)}s`);
        playSegment(nextIndex, offset);
        sendStatusUpdate({ state: "playing", segmentIndex: nextIndex });
        return;
      }

      // Fallback: Find segment based on current video time
      const currentTime = videoElement.currentTime;
      nextIndex = findSegmentIndexForTime(currentTime, syncAudioData);
      if (nextIndex >= 0 && nextIndex !== endedSegmentIndex) {
        const offset = Math.max(0, currentTime - (syncAudioData[nextIndex]?.startTime ?? currentTime));
        console.log(`Playing segment ${nextIndex} at offset ${offset.toFixed(2)}s (time-based fallback)`);
        playSegment(nextIndex, offset);
        sendStatusUpdate({ state: "playing", segmentIndex: nextIndex });
      } else {
        console.log("No valid next segment to play.");
        sendStatusUpdate({ state: "paused", segmentIndex: endedSegmentIndex });
      }
    }

    function handleAudioError(event?: Event | Error | string, segmentId?: string) {
      console.error(
        `Audio Playback Error for ${segmentId ?? `Seg ${currentSegmentIndex}`}:`,
        event
      );
      isAudioPlaying = false;
      sendStatusUpdate({
        state: "error",
        message: `Audio playback error for segment ${segmentId ?? currentSegmentIndex}. Try pausing and resuming the video.`,
      });

      // Attempt recovery
      if (isSyncActive && videoElement && syncAudioData && !videoElement.paused) {
        const currentTime = videoElement.currentTime;
        let nextIndex = currentSegmentIndex;
        
        // First, try reloading the current segment
        if (audioBlobUrls.has(currentSegmentIndex)) {
          URL.revokeObjectURL(audioBlobUrls.get(currentSegmentIndex)!);
          audioBlobUrls.delete(currentSegmentIndex);
        }
        console.log(`Attempting to reload segment ${currentSegmentIndex}`);
        const offset = currentTime - (syncAudioData[currentSegmentIndex]?.startTime ?? currentTime);
        playSegment(currentSegmentIndex, Math.max(0, offset));
        
        // If reload fails, try the next segment after a delay
        setTimeout(() => {
          if (!isAudioPlaying && isSyncActive && videoElement && syncAudioData && !videoElement.paused) {
            nextIndex = currentSegmentIndex + 1 < syncAudioData.length 
              ? currentSegmentIndex + 1 
              : findSegmentIndexForTime(videoElement.currentTime, syncAudioData);
            if (nextIndex >= 0 && nextIndex !== currentSegmentIndex) {
              const nextOffset = videoElement.currentTime - (syncAudioData[nextIndex]?.startTime ?? videoElement.currentTime);
              console.log(`Attempting recovery by playing segment ${nextIndex}`);
              playSegment(nextIndex, Math.max(0, nextOffset));
            }
          }
        }, 2000);
      }
    }

    function attachVideoListeners() {
      console.log("attachVideoListeners function called!");
      if (!videoElement) return;
      videoElement.addEventListener("play", handleVideoPlay, { passive: true });
      videoElement.addEventListener("pause", handleVideoPause, { passive: true });
      videoElement.addEventListener("seeked", handleVideoSeeked, { passive: true });
    }

    function detachVideoListeners() {
      console.log("detachVideoListeners function called!");
      if (!videoElement) return;
      videoElement.removeEventListener("play", handleVideoPlay);
      videoElement.removeEventListener("pause", handleVideoPause);
      videoElement.removeEventListener("seeked", handleVideoSeeked);
    }

    function sendStatusUpdate(status: Partial<SyncStatus>) {
      browser.runtime
        .sendMessage({ action: ACTION.SYNC_STATUS_UPDATE, payload: status })
        .catch((err) => {
          if (err.message?.includes("Receiving end does not exist")) {
            /* Normal if popup closed */
          } else {
            console.warn("Error sending status update to popup:", err);
          }
        });
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === ACTION.GET_TRANSCRIPTION) {
        console.log("Content Script: Received GET_TRANSCRIPTION");
        (async () => {
          try {
            const buttonClickedOrOpen = await clickTranscriptButton();
            if (!buttonClickedOrOpen) {
              throw new Error(
                "Could not find or click the 'Show transcript' button/menu item."
              );
            }

            let transcriptFound = false;
            const observerTargetNode = document.body;
            const observerOptions = { childList: true, subtree: true };

            const observerCallback: MutationCallback = (
              mutationsList,
              observer
            ) => {
              if (transcriptFound) return;

              const currentTranscript = scrapeTranscript();
              if (currentTranscript) {
                console.log("Transcript detected via MutationObserver.");
                transcriptFound = true;
                observer.disconnect();
                transcriptData = currentTranscript;
                sendResponse({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: transcriptData,
                });
              }
            };
            const observer = new MutationObserver(observerCallback);

            setTimeout(() => {
              if (transcriptFound) return;
              const initialData = scrapeTranscript();
              if (initialData) {
                console.log("Transcript found on initial check.");
                transcriptFound = true;
                transcriptData = initialData;
                browser.runtime.sendMessage({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: transcriptData,
                });
              } else {
                console.log("Transcript not found initially, starting MutationObserver...");
                observer.observe(observerTargetNode, observerOptions);
                setTimeout(() => {
                  if (!transcriptFound) {
                    observer.disconnect();
                    console.error("Timeout waiting for transcript after button click.");
                    browser.runtime.sendMessage({
                      action: ACTION.TRANSCRIPTION_ERROR,
                      payload: "Timeout waiting for transcript.",
                    });
                  }
                }, 10000);
              }
            }, 1500);
          } catch (error: any) {
            console.error("Error getting transcript:", error);
            browser.runtime.sendMessage({
              action: ACTION.TRANSCRIPTION_ERROR,
              payload: error.message || "Unknown error getting transcript.",
            });
          }
        })();
      }

      if (message.action === ACTION.SYNC_AUDIO_READY) {
        console.log("Content Script: Received SYNC_AUDIO_READY", message.payload);
        syncAudioData = message.payload as SegmentAudioData[];
        cleanupBlobUrls();
        console.log(`Received ${syncAudioData.length} audio segments for sync.`);
        if (isSyncActive) {
          console.log("Audio ready, starting sync playback now.");
          startSync();
        } else {
          sendStatusUpdate({
            state: "ready",
            message: "Audio ready for sync.",
          });
        }
        return false;
      }

      if (message.action === ACTION.SYNC_AUDIO_FAILED) {
        console.error("Content Script: Received SYNC_AUDIO_FAILED", message.payload);
        stopSync();
        syncAudioData = null;
        sendStatusUpdate({
          state: "error",
          message: `Audio generation failed: ${message.payload}`,
        });
        return false;
      }

      if (message.action === ACTION.START_SYNC_PLAYBACK) {
        console.log("Content Script: Received START_SYNC_PLAYBACK");
        const { language } = message.payload;

        if (!transcriptData) {
          console.error("Cannot start sync: Transcript not available.");
          sendStatusUpdate({
            state: "error",
            message: "Get transcript first.",
          });
          return false;
        }

        isSyncActive = true;

        if (syncAudioData) {
          console.log("Audio data present, starting sync immediately.");
          startSync();
        } else {
          console.log("Requesting sync audio from background...");
          sendStatusUpdate({
            state: "loading",
            message: "Generating audio...",
          });
          browser.runtime
            .sendMessage({
              action: ACTION.REQUEST_SYNC_AUDIO,
              payload: {
                transcription: transcriptData,
                language: language,
              },
            })
            .catch((err) => {
              console.error("Error sending REQUEST_SYNC_AUDIO to background:", err);
              stopSync();
              sendStatusUpdate({
                state: "error",
                message: "Failed to request audio generation.",
              });
            });
        }
        return false;
      }

      if (message.action === ACTION.STOP_SYNC_PLAYBACK) {
        console.log("Content Script: Received STOP_SYNC_PLAYBACK");
        stopSync();
        return false;
      }

      return false;
    });

    const videoFindRetryInterval = setInterval(() => {
      if (!videoElement) {
        findVideoElement();
      } else {
        clearInterval(videoFindRetryInterval);
      }
    }, 3000);

    window.addEventListener("beforeunload", cleanupResources);

    console.log("Content script main function finished.");
  },
});
