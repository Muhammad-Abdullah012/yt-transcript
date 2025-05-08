<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { ACTION } from "../../constants";
  import type { TranscriptSegment, SyncStatus } from "@/interfaces"; // Import interfaces
  import { formatTranscript } from "@/lib/scrapTranscript"; // For optional display

  // --- Core State ---
  let transcription: TranscriptSegment[] | null = null;
  let isLoadingTranscription = false;
  let errorMessage: string | null = null;
  let currentTabId: number | null = null;
  let selectedLanguage = "Italian"; // Default language

  // --- Sync Playback State ---
  let syncState: SyncStatus["state"] = "stopped";
  let syncMessage: string | null = null;
  let currentSyncSegmentIndex: number = -1;

  // --- Download State ---
  let downloadState:
    | "idle"
    | "preparing"
    | "ready"
    | "merging"
    | "downloading"
    | "error" = "idle";
  let downloadPrepProgress = { current: 0, total: 0 };
  let downloadError: string | null = null;
  let downloadDataUrl: string | null = null; // Stores merged audio data URL

  // --- Communication Port ---
  let audioPort: Browser.runtime.Port | null = null;
  let portError: string | null = null;

  // --- Lifecycle ---
  onMount(async () => {
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
        url: "*://*.youtube.com/watch*",
      });

      if (tabs.length > 0 && tabs[0]?.id) {
        currentTabId = tabs[0].id;
        console.log("Popup opened on YouTube tab:", currentTabId);
        // Listen for status updates from content script
        browser.runtime.onMessage.addListener(handleRuntimeMessages);
      } else {
        errorMessage = "Not on an active YouTube video page.";
      }
    } catch (error: any) {
      console.error("Error querying tabs:", error);
      errorMessage = `Error finding YouTube tab: ${error.message}`;
    }
  });

  onDestroy(() => {
    browser.runtime.onMessage.removeListener(handleRuntimeMessages);
    disconnectPort(); // Ensure port is closed
    console.log("Popup destroyed, listener removed, port disconnected.");
  });

  // --- Message Handling ---
  function handleRuntimeMessages(
    message: any,
    sender: Browser.runtime.MessageSender
  ) {
    // Handle messages from Content Script
    if (sender.tab?.id === currentTabId) {
      if (message.action === ACTION.SYNC_STATUS_UPDATE) {
        console.log("Popup received SYNC_STATUS_UPDATE:", message.payload);
        const {
          state,
          message: msg,
          segmentIndex,
          error,
        } = message.payload as SyncStatus;
        syncState = state ?? syncState;
        syncMessage =
          msg ?? error ?? (state === "stopped" ? "Sync stopped." : null); // Provide default stopped message
        currentSyncSegmentIndex = segmentIndex ?? -1;
        if (state === "error")
          errorMessage = `Sync Error: ${msg || "Unknown error"}`;
        // Clear other errors if sync becomes active/ready
        if (syncState !== "error" && syncState !== "stopped") {
          errorMessage = null;
          portError = null;
          downloadError = null;
        }
      } else if (message.action === ACTION.TRANSCRIPTION_RESULT) {
        console.log("Popup received TRANSCRIPTION_RESULT");
        isLoadingTranscription = false;
        transcription = message.payload;
        errorMessage = null;
        resetDownloadState(); // Reset download if new transcript arrives
      } else if (message.action === ACTION.TRANSCRIPTION_ERROR) {
        console.error("Popup received TRANSCRIPTION_ERROR:", message.payload);
        isLoadingTranscription = false;
        errorMessage = `Transcript Error: ${message.payload}`;
        transcription = null;
        resetDownloadState();
      }
    }
    // Ignore messages from other tabs or background for this listener
  }

  function handlePortMessage(msg: any) {
    if (!audioPort) return; // Port closed

    // console.log("Port message received:", msg.type); // Can be noisy

    if (msg.type === ACTION.AUDIO_CHUNK) {
      downloadState = "preparing";
      downloadPrepProgress = { current: msg.index + 1, total: msg.total };
    } else if (msg.type === ACTION.STREAM_COMPLETE) {
      console.log("Port audio stream complete (download prep finished).");
      downloadState = "ready"; // Ready to merge
      downloadPrepProgress.current = downloadPrepProgress.total; // Ensure progress shows 100%
      requestMergeAndDownload();
    } else if (msg.type === ACTION.MERGE_AUDIO_RESULT) {
      if (msg.error) {
        console.error("Error merging audio:", msg.error);
        downloadError = `Merge failed: ${msg.error}`;
        downloadState = "error";
      } else {
        console.log("Audio merge successful.");
        downloadDataUrl = msg.payload; // Store the data URL
        downloadState = "downloading"; // Trigger download effect
        // Initiate download immediately after receiving data URL
        if (!downloadDataUrl) {
          console.error("No data URL received for download.");
          downloadError = "Download failed: No audio data received.";
          downloadState = "error";
          return;
        }
        triggerDownload(downloadDataUrl);
        // Reset state after a short delay?
        setTimeout(() => {
          if (downloadState === "downloading") {
            downloadState = "ready"; // Go back to ready state after download starts
          }
        }, 1500);
      }
    } else if (msg.type === ACTION.ERROR) {
      console.error("Error from background port stream:", msg.error);
      portError = `Audio Stream Error: ${msg.error}`;
      downloadError = `Audio generation failed: ${msg.error}`; // Show as download error
      downloadState = "error";
      disconnectPort(); // Disconnect on stream error
    }
  }

  function handlePortDisconnect() {
    if (!audioPort) return; // Already handled
    const portId = audioPort.name;
    console.log(`Background port ${portId} disconnected.`);
    // If disconnect was unexpected during prep/merge
    if (downloadState === "preparing" || downloadState === "merging") {
      console.warn("Port disconnected unexpectedly during download process.");
      if (!downloadError)
        downloadError = "Connection lost during audio processing.";
      downloadState = "error";
    }
    audioPort = null; // Clear the port reference
    portError = null; // Clear port-specific error
  }

  function connectPort(purpose: string = "audio-download"): boolean {
    if (audioPort) {
      console.warn("Port already connected. Disconnecting old one.");
      disconnectPort();
    }
    try {
      console.log(`Connecting port for: ${purpose}`);
      // Include purpose in name for better debugging in background
      const portName = `${purpose}_${Date.now()}`;
      audioPort = browser.runtime.connect({ name: portName });
      audioPort.onMessage.addListener(handlePortMessage);
      audioPort.onDisconnect.addListener(handlePortDisconnect);
      portError = null; // Clear previous errors on new connection
      return true;
    } catch (error: any) {
      console.error("Error connecting port:", error);
      portError = `Connection Error: ${error.message}`;
      audioPort = null;
      return false;
    }
  }

  function disconnectPort() {
    if (audioPort) {
      // console.log("Disconnecting port from popup.");
      audioPort.onMessage.removeListener(handlePortMessage);
      audioPort.onDisconnect.removeListener(handlePortDisconnect);
      audioPort.disconnect();
      audioPort = null;
    }
  }

  // --- Actions ---

  async function getTranscription() {
    if (!currentTabId || isLoadingTranscription) return;

    isLoadingTranscription = true;
    errorMessage = null;
    portError = null;
    syncMessage = null;
    transcription = null;
    syncState = "stopped";
    resetDownloadState(); // Reset download state
    disconnectPort(); // Disconnect any existing port

    console.log(`Sending ${ACTION.GET_TRANSCRIPTION} to tab ${currentTabId}`);
    try {
      await browser.tabs.sendMessage(currentTabId, {
        action: ACTION.GET_TRANSCRIPTION,
      });
      // Wait for TRANSCRIPTION_RESULT or TRANSCRIPTION_ERROR via handleRuntimeMessages
    } catch (error: any) {
      console.error("Error sending GET_TRANSCRIPTION:", error);
      errorMessage = `Error contacting content script: ${error.message}. Try reloading the page/extension.`;
      isLoadingTranscription = false;
    }
  }

  function startSyncPlayback() {
    if (!currentTabId || !transcription) {
      errorMessage = "Get transcription first.";
      return;
    }
    if (
      syncState === "loading" ||
      syncState === "playing" ||
      syncState === "paused"
    )
      return;

    console.log("Requesting START_SYNC_PLAYBACK from content script");
    // Optimistically set state, content script update will confirm/correct
    syncState = "loading";
    syncMessage = "Initializing sync...";
    errorMessage = null;
    portError = null;
    downloadError = null; // Clear download errors when starting sync

    browser.tabs
      .sendMessage(currentTabId, {
        action: ACTION.START_SYNC_PLAYBACK,
        payload: { language: selectedLanguage },
      })
      .catch((err) => {
        console.error("Error sending START_SYNC_PLAYBACK:", err);
        errorMessage = `Error starting sync: ${err.message}`;
        syncState = "error"; // Revert state on send error
      });
  }

  function stopSyncPlayback() {
    if (!currentTabId || syncState === "stopped") return;

    console.log("Requesting STOP_SYNC_PLAYBACK from content script");
    syncState = "stopped"; // Assume stop succeeds
    syncMessage = "Sync stopped.";
    currentSyncSegmentIndex = -1;

    browser.tabs
      .sendMessage(currentTabId, { action: ACTION.STOP_SYNC_PLAYBACK })
      .catch((err) => {
        console.error("Error sending STOP_SYNC_PLAYBACK:", err);
        errorMessage = `Error stopping sync: ${err.message}`;
        // State might be inconsistent if message fails, but UI shows stopped
      });
  }

  function prepareDownloadAudio() {
    if (
      !currentTabId ||
      !transcription ||
      downloadState === "preparing" ||
      downloadState === "merging"
    )
      return;
    if (syncState !== "stopped") {
      downloadError = "Stop synchronized playback before preparing download.";
      return;
    }

    console.log("Requesting audio preparation for download...");
    resetDownloadState(); // Clear previous download state/errors
    downloadState = "preparing";
    downloadPrepProgress = { current: 0, total: 0 };

    if (!connectPort("audio-download-prep")) {
      downloadState = "error";
      downloadError = portError || "Failed to connect to background service.";
      return;
    }

    // Send request to background via port
    audioPort?.postMessage({
      action: ACTION.START_AUDIO_STREAM,
      payload: {
        transcription,
        language: selectedLanguage,
      },
    });
  }

  function requestMergeAndDownload() {
    if (downloadState !== "ready" || !audioPort) {
      downloadError =
        "Audio not ready or connection lost. Please 'Load Audio' again.";
      if (downloadState !== "error") downloadState = "idle"; // Reset if not already error
      return;
    }

    console.log("Requesting audio merge from background...");
    downloadState = "merging";
    downloadError = null;

    audioPort.postMessage({ action: ACTION.MERGE_PORT_AUDIO });
    // Wait for MERGE_AUDIO_RESULT in handlePortMessage
  }

  function triggerDownload(dataUrl: string) {
    try {
      const a = document.createElement("a");
      a.href = dataUrl;
      // Suggest filename based on language and maybe video title later
      a.download = `youtube_translation_${selectedLanguage.toLowerCase()}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Data URLs don't need URL.revokeObjectURL
      console.log("Download triggered.");
    } catch (error: any) {
      console.error("Error triggering download:", error);
      downloadError = `Failed to initiate download: ${error.message}`;
      downloadState = "error";
    }
  }

  function resetDownloadState() {
    downloadState = "idle";
    downloadError = null;
    downloadPrepProgress = { current: 0, total: 0 };
    downloadDataUrl = null;
    // Don't disconnect port here, might be needed if user retries quickly
  }

  // --- Reactive Computations ---
  $: canGetTranscription = !isLoadingTranscription && !!currentTabId;
  $: canControlSync =
    !!transcription && !!currentTabId && !isLoadingTranscription;
  $: canStartSync =
    canControlSync &&
    syncState !== "playing" &&
    syncState !== "paused" &&
    syncState !== "loading";
  $: canStopSync =
    canControlSync &&
    (syncState === "playing" ||
      syncState === "paused" ||
      syncState === "ready" ||
      syncState === "error");

  $: canPrepareDownload =
    !!transcription &&
    !!currentTabId &&
    syncState === "stopped" &&
    downloadState !== "preparing" &&
    downloadState !== "merging";
  $: canDownloadNow = downloadState === "ready"; // Only allow merge request when ready

  $: syncStatusText =
    syncState === "loading"
      ? syncMessage || "Loading audio..."
      : syncState === "playing"
        ? `Playing ${currentSyncSegmentIndex >= 0 ? `segment ${currentSyncSegmentIndex + 1}` : "..."}` +
          (syncMessage ? ` (${syncMessage})` : "")
        : syncState === "paused"
          ? `Paused ${currentSyncSegmentIndex >= 0 ? `at segment ${currentSyncSegmentIndex + 1}` : ""}` +
            (syncMessage ? ` (${syncMessage})` : "")
          : syncState === "ready"
            ? syncMessage || "Audio ready for sync"
            : syncState === "error"
              ? `Error: ${syncMessage || "Unknown error"}`
              : syncState === "stopped"
                ? syncMessage || "Sync stopped."
                : "Sync Idle";

  $: downloadButtonText =
    downloadState === "idle"
      ? "Download Audio"
      : downloadState === "preparing"
        ? `Loading ${downloadPrepProgress.current}/${downloadPrepProgress.total}...`
        : downloadState === "ready"
          ? "Download Now"
          : downloadState === "merging"
            ? "Merging Audio..."
            : downloadState === "downloading"
              ? "Downloading..."
              : downloadState === "error"
                ? "Retry Download Prep"
                : "Download Audio";

  $: isDownloadProcessActive =
    downloadState === "preparing" ||
    downloadState === "merging" ||
    downloadState === "downloading";
</script>

<main class="min-w-[350px] max-w-[500px] p-4 bg-gray-100 font-sans">
  <h1 class="text-2xl font-bold text-gray-800 mb-4 text-center">
    YouTube Sync Translator
  </h1>
  <div class="bg-white rounded-lg shadow-md p-6">
    {#if currentTabId}
      <!-- Language Selector -->
      <div class="mb-4">
        <label
          for="language-select"
          class="block text-sm font-medium text-gray-700 mb-1"
          >Select Language</label
        >
        <select
          id="language-select"
          bind:value={selectedLanguage}
          disabled={syncState !== "stopped" ||
            isLoadingTranscription ||
            isDownloadProcessActive}
          class="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
          aria-label="Select translation language"
        >
          <option value="Italian">Italian</option>
          <option value="Spanish">Spanish</option>
          <option value="French">French</option>
          <option value="German">German</option>
          <option value="Portuguese">Portuguese</option>
        </select>
      </div>

      <!-- Get Transcription Button -->
      <button
        on:click={getTranscription}
        disabled={!canGetTranscription || syncState !== "stopped"}
        class="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
        aria-label="Get YouTube video transcript"
      >
        {#if isLoadingTranscription}
          <svg class="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          Loading Transcript...
        {:else}
          Get YouTube Transcript
        {/if}
      </button>
    {:else if !errorMessage}
      <p class="text-sm text-gray-600 bg-gray-100 p-3 rounded-md text-center">
        Open a YouTube video page to use this extension.
      </p>
    {/if}

    <!-- Error Messages -->
    {#if errorMessage}
      <p class="mt-3 text-sm text-red-600 bg-red-100 p-3 rounded-md">
        {errorMessage}
      </p>
    {/if}
    {#if portError}
      <p class="mt-2 text-xs text-red-600 bg-red-100 p-2 rounded-md">
        {portError}
      </p>
    {/if}

    {#if transcription}
      <!-- Sync Controls -->
      <div class="mt-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-3">
          Synchronized Playback
        </h2>
        {#if syncState !== "stopped" || syncMessage}
          <p
            class="text-sm p-3 rounded-md {syncState === 'error'
              ? 'text-red-600 bg-red-100'
              : syncState === 'ready' || syncState === 'loading'
                ? 'text-blue-600 bg-blue-100'
                : 'text-gray-600 bg-gray-100'}"
          >
            Status: {syncStatusText}
          </p>
        {/if}
        <div class="flex space-x-2 mt-3">
          <button
            on:click={startSyncPlayback}
            disabled={!canStartSync}
            class="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            aria-label="Start synchronized playback"
          >
            Start Sync
          </button>
          <button
            on:click={stopSyncPlayback}
            disabled={!canStopSync}
            class="flex-1 bg-red-600 text-white py-2 px-4 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            aria-label="Stop synchronized playback"
          >
            Stop Sync
          </button>
        </div>
      </div>

      <!-- Download Controls -->
      <div class="mt-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-3">
          Download Audio (WAV)
        </h2>
        {#if syncState !== "stopped"}
          <p class="text-xs text-gray-600 bg-gray-100 p-2 rounded-md">
            Stop synchronized playback to enable download.
          </p>
        {/if}
        <button
          on:click={prepareDownloadAudio}
          disabled={syncState !== "stopped" ||
            isLoadingTranscription ||
            (downloadState !== "idle" &&
              downloadState !== "ready" &&
              downloadState !== "error")}
          class="w-full bg-purple-600 text-white py-2 px-4 rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors mt-2"
          title={downloadState === "ready"
            ? "Merge generated audio and download"
            : "Generate audio segments for download"}
          aria-label="Download translated audio"
        >
          {#if isDownloadProcessActive && downloadState !== "ready"}
            <svg class="animate-spin h-5 w-5 mr-2 inline" viewBox="0 0 24 24">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
          {/if}
          {downloadButtonText}
        </button>
        {#if downloadError}
          <p class="mt-2 text-xs text-red-600 bg-red-100 p-2 rounded-md">
            {downloadError}
          </p>
        {/if}
        {#if downloadState === "preparing"}
          <div class="mt-3">
            <div class="w-full bg-gray-200 rounded-full h-2.5">
              <div
                class="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                style="width: {(downloadPrepProgress.current /
                  (downloadPrepProgress.total || 1)) *
                  100}%"
              ></div>
            </div>
            <p class="text-xs text-gray-600 mt-1">
              Progress: {downloadPrepProgress.current}/{downloadPrepProgress.total}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</main>
