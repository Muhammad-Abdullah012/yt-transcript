import { ACTION, TRANSCRIPT_CHECK_INTERVAL, TRANSCRIPT_CHECK_TIMEOUT } from "@/constants";
import { clickTranscriptButton, formatTranscript, scrapeTranscript } from "@/lib/scrapTranscript";

export default defineContentScript({
  matches: ['*://*.youtube.com/watch*'],
  runAt: "document_idle",
  main() {
    console.log('Content script loaded.');

    browser.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
      if (message.action === ACTION.GET_TRANSCRIPTION) {

        (async () => {
          try {
            console.log("Processing GET_TRANSCRIPTION action...");

            // 1. Try to click the button (or check if already open)
            const buttonClickedOrOpen = clickTranscriptButton();
            if (!buttonClickedOrOpen) {
              throw new Error("Could not find or click the 'Show transcript' button.");
            }

            // Method 1: Using MutationObserver (More robust and efficient)
            let transcriptFound = false;
            const observerTargetNode = document.body; // Observe the whole body, or a closer parent if known
            const observerOptions = {
              childList: true, // Watch for addition/removal of children
              subtree: true    // Watch descendants too
            };

            const observerCallback: MutationCallback = (mutationsList, observer) => {
              if (transcriptFound) {
                // observer.disconnect(); // Optional: Stop observing once found if you only need it once
                return;
              }

              // Check if the transcript is now available on DOM changes
              const transcriptData = scrapeTranscript();
              if (transcriptData) {
                console.log("Transcript detected via MutationObserver.");
                transcriptFound = true;
                observer.disconnect();
                const formatted = formatTranscript(transcriptData);
                sendResponse({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: formatted
                });
              }
            };

            const observer = new MutationObserver(observerCallback);

            // Start observing
            // We wait a bit before starting the observer to avoid catching initial page load churn
            setTimeout(() => {
              // Initial check in case it's already there when the script runs
              const initialData = scrapeTranscript();
              if (initialData) {
                console.log("Transcript found on initial check.");
                transcriptFound = true;
                const formatted = formatTranscript(initialData);
                sendResponse({
                  action: ACTION.TRANSCRIPTION_RESULT,
                  payload: formatted
                });
              } else {
                console.log("Transcript not found initially, starting MutationObserver...");
                observer.observe(observerTargetNode, observerOptions);
              }
            }, 1500); // Wait 1.5 seconds before starting checks/observer

          } catch (error: any) {
            console.error("Error getting transcript:", error);
            sendResponse({
              action: ACTION.TRANSCRIPTION_ERROR,
              payload: error.message || "An unknown error occurred."
            });
          }
        })();
        return true;
      }
    });
  },
});
