<script lang="ts">
  import { onMount } from "svelte";
  import { ACTION } from "../../constants";
  import { formatTranscript } from "@/lib/scrapTranscript";

  interface TranscriptSegment {
    timestamp: string;
    text: string;
  }

  let transcription: TranscriptSegment[] | null = null;
  let isLoading = false;
  let errorMessage: string | null = null;
  let currentTabId: number | null = null;

  onMount(async () => {
    try {
      // Query for the active tab in the current window that matches the YouTube URL
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
        url: "*://*.youtube.com/watch*", // Ensure it's a YouTube watch page
      });

      if (tabs.length > 0 && tabs[0]?.id) {
        currentTabId = tabs[0].id;
        console.log("Popup opened on YouTube tab:", currentTabId);
      } else {
        errorMessage = "Not on an active YouTube video page.";
        console.log("Popup not opened on an active YouTube watch page.");
      }
    } catch (error) {
      console.error("Error querying tabs:", error);
      errorMessage = "Error finding YouTube tab. Check console.";
    }
  });

  async function getTranscription() {
    if (!currentTabId) {
      errorMessage = "Cannot find the active YouTube tab.";
      return;
    }

    isLoading = true;
    errorMessage = null;
    transcription = null; // Clear previous transcription

    console.log(`Sending ${ACTION.GET_TRANSCRIPTION} to tab ${currentTabId}`);

    try {
      const response = await browser.tabs.sendMessage(currentTabId, {
        action: ACTION.GET_TRANSCRIPTION,
      });

      console.log("Response received from content script:", response);

      if (response?.action === ACTION.TRANSCRIPTION_RESULT) {
        transcription = response.payload;
      } else if (response?.action === ACTION.TRANSCRIPTION_ERROR) {
        errorMessage = `Error: ${response.payload}`;
      } else {
        if (!response) {
          errorMessage =
            "No response from content script. Try reloading the YouTube page and the extension.";
        } else {
          errorMessage = "Received an unexpected response from content script.";
        }
        console.error("Unexpected response:", response);
      }
    } catch (error: any) {
      console.error("Error sending message or receiving response:", error);
      // Check for common errors
      if (
        error.message?.includes("Could not establish connection") ||
        error.message?.includes("Receiving end does not exist")
      ) {
        errorMessage =
          "Cannot connect to the YouTube page. Please reload the page and try again. If the issue persists, reload the extension.";
      } else {
        errorMessage = `Error: ${error.message || "An unknown error occurred."}`;
      }
      transcription = null;
    } finally {
      isLoading = false;
    }
  }
</script>

<main>
  <h1>YouTube Transcript</h1>
  <div class="card">
    {#if currentTabId}
      <button on:click={getTranscription} disabled={isLoading}>
        {#if isLoading}
          Loading...
        {:else}
          Get Transcription
        {/if}
      </button>
    {/if}

    {#if errorMessage}
      <p class="message error">Error: {errorMessage}</p>
    {/if}

    {#if transcription}
      <textarea class="message transcript-area" readonly
        >{formatTranscript(transcription)}</textarea
      >
    {/if}

    {#if !currentTabId && !errorMessage}
      <p class="message info">
        Open a YouTube video page to use this extension.
      </p>
    {/if}
  </div>
</main>

<style>
  main {
    font-family: sans-serif;
    padding: 1em;
    min-width: 300px; /* Ensure popup has some width */
  }
  .card {
    border: 1px solid #ccc;
    padding: 1em;
    border-radius: 4px;
  }
  button {
    padding: 0.5em 1em;
    cursor: pointer;
    margin-bottom: 1em;
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .message {
    margin-top: 1em;
    white-space: pre-wrap; /* Keep line breaks */
    word-wrap: break-word;
    font-size: 0.9em;
    max-height: 300px; /* Limit height */
    overflow-y: auto; /* Add scrollbar if needed */
    border: 1px solid #eee;
    padding: 0.5em;
    background-color: #f9f9f9;
    color: #333;
  }
  .transcript-area {
    width: 95%; /* Make textarea fill container */
    min-height: 150px;
    resize: vertical; /* Allow vertical resize */
  }
  .error {
    color: red;
    border-color: red;
    background-color: #ffebeb;
  }
  .info {
    color: #333;
    background-color: #f0f0f0;
  }
</style>
