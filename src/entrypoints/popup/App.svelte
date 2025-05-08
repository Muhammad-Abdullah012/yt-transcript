<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { ACTION } from "../../constants";
  import type { TranscriptSegment, SyncStatus } from "@/interfaces";

  // --- Core State ---
  let transcription: TranscriptSegment[] | null = null;
  let isLoadingTranscription = false;
  let errorMessage: string | null = null;
  let currentTabId: number | null = null;
  let selectedLanguage = "Italian";

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
  let downloadDataUrl: string | null = null;

  // --- Communication Port ---
  let audioPort: Browser.runtime.Port | null = null;
  let portError: string | null = null;

  // --- Theme State ---
  let theme: "light" | "dark" | "system" = "system";
  let isDarkMode = false;

  // Load theme from localStorage or default to system
  onMount(() => {
    const savedTheme = localStorage.getItem("theme") as
      | "light"
      | "dark"
      | "system"
      | null;
    console.log("savedTheme => ", savedTheme);
    if (savedTheme) {
      theme = savedTheme;
    }
    updateTheme();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  });

  // Theme handling
  function updateTheme() {
    console.log("updating theme")
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    isDarkMode = theme === 'dark' || (theme === 'system' && prefersDark);
    console.log("isDarkMode =< ", isDarkMode);
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }

  function handleSystemThemeChange() {
    if (theme === "system") {
      updateTheme();
    }
  }

  function toggleTheme() {
    theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    updateTheme();
  }

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
    disconnectPort();
    console.log("Popup destroyed, listener removed, port disconnected.");
  });

  // --- Message Handling ---
  function handleRuntimeMessages(
    message: any,
    sender: Browser.runtime.MessageSender
  ) {
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
          msg ?? error ?? (state === "stopped" ? "Sync stopped." : null);
        currentSyncSegmentIndex = segmentIndex ?? -1;
        if (state === "error")
          errorMessage = `Sync Error: ${msg || "Unknown error"}`;
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
        resetDownloadState();
      } else if (message.action === ACTION.TRANSCRIPTION_ERROR) {
        console.error("Popup received TRANSCRIPTION_ERROR:", message.payload);
        isLoadingTranscription = false;
        errorMessage = `Transcript Error: ${message.payload}`;
        transcription = null;
        resetDownloadState();
      }
    }
  }

  function handlePortMessage(msg: any) {
    if (!audioPort) return;
    if (msg.type === ACTION.AUDIO_CHUNK) {
      downloadState = "preparing";
      downloadPrepProgress = { current: msg.index + 1, total: msg.total };
    } else if (msg.type === ACTION.STREAM_COMPLETE) {
      console.log("Port audio stream complete (download prep finished).");
      downloadState = "ready";
      downloadPrepProgress.current = downloadPrepProgress.total;
      requestMergeAndDownload();
    } else if (msg.type === ACTION.MERGE_AUDIO_RESULT) {
      if (msg.error) {
        console.error("Error merging audio:", msg.error);
        downloadError = `Merge failed: ${msg.error}`;
        downloadState = "error";
      } else {
        console.log("Audio merge successful.");
        downloadDataUrl = msg.payload;
        downloadState = "downloading";
        if (!downloadDataUrl) {
          console.error("No data URL received for download.");
          downloadError = "Download failed: No audio data received.";
          downloadState = "error";
          return;
        }
        triggerDownload(downloadDataUrl);
        setTimeout(() => {
          if (downloadState === "downloading") {
            downloadState = "ready";
          }
        }, 1500);
      }
    } else if (msg.type === ACTION.ERROR) {
      console.error("Error from background port stream:", msg.error);
      portError = `Audio Stream Error: ${msg.error}`;
      downloadError = `Audio generation failed: ${msg.error}`;
      downloadState = "error";
      disconnectPort();
    }
  }

  function handlePortDisconnect() {
    if (!audioPort) return;
    const portId = audioPort.name;
    console.log(`Background port ${portId} disconnected.`);
    if (downloadState === "preparing" || downloadState === "merging") {
      console.warn("Port disconnected unexpectedly during download process.");
      if (!downloadError)
        downloadError = "Connection lost during audio processing.";
      downloadState = "error";
    }
    audioPort = null;
    portError = null;
  }

  function connectPort(purpose: string = "audio-download"): boolean {
    if (audioPort) {
      console.warn("Port already connected. Disconnecting old one.");
      disconnectPort();
    }
    try {
      console.log(`Connecting port for: ${purpose}`);
      const portName = `${purpose}_${Date.now()}`;
      audioPort = browser.runtime.connect({ name: portName });
      audioPort.onMessage.addListener(handlePortMessage);
      audioPort.onDisconnect.addListener(handlePortDisconnect);
      portError = null;
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
    resetDownloadState();
    disconnectPort();
    console.log(`Sending ${ACTION.GET_TRANSCRIPTION} to tab ${currentTabId}`);
    try {
      await browser.tabs.sendMessage(currentTabId, {
        action: ACTION.GET_TRANSCRIPTION,
      });
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
    syncState = "loading";
    syncMessage = "Initializing sync...";
    errorMessage = null;
    portError = null;
    downloadError = null;
    browser.tabs
      .sendMessage(currentTabId, {
        action: ACTION.START_SYNC_PLAYBACK,
        payload: { language: selectedLanguage },
      })
      .catch((err) => {
        console.error("Error sending START_SYNC_PLAYBACK:", err);
        errorMessage = `Error starting sync: ${err.message}`;
        syncState = "error";
      });
  }

  function stopSyncPlayback() {
    if (!currentTabId || syncState === "stopped") return;
    console.log("Requesting STOP_SYNC_PLAYBACK from content script");
    syncState = "stopped";
    syncMessage = "Sync stopped.";
    currentSyncSegmentIndex = -1;
    browser.tabs
      .sendMessage(currentTabId, { action: ACTION.STOP_SYNC_PLAYBACK })
      .catch((err) => {
        console.error("Error sending STOP_SYNC_PLAYBACK:", err);
        errorMessage = `Error stopping sync: ${err.message}`;
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
    resetDownloadState();
    downloadState = "preparing";
    downloadPrepProgress = { current: 0, total: 0 };
    if (!connectPort("audio-download-prep")) {
      downloadState = "error";
      downloadError = portError || "Failed to connect to background service.";
      return;
    }
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
      if (downloadState !== "error") downloadState = "idle";
      return;
    }
    console.log("Requesting audio merge from background...");
    downloadState = "merging";
    downloadError = null;
    audioPort.postMessage({ action: ACTION.MERGE_PORT_AUDIO });
  }

  function triggerDownload(dataUrl: string) {
    try {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `youtube_translation_${selectedLanguage.toLowerCase()}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
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
  $: canDownloadNow = downloadState === "ready";
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

<main
  class="min-w-[350px] max-w-[500px] p-4 bg-gray-100 dark:bg-gray-900 font-sans transition-colors duration-300"
>
  <div class="flex justify-between items-center mb-4">
    <h1 class="text-2xl font-bold text-gray-800 dark:text-gray-100">
      YouTube Sync Translator
    </h1>
    <button
      on:click={toggleTheme}
      class="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      aria-label="Toggle theme"
      title="Toggle between light, dark, and system themes"
    >
      {#if theme === "light"}
        <svg
          class="w-5 h-5 text-gray-800 dark:text-gray-100"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          ></path>
        </svg>
      {:else if theme === "dark"}
        <svg
          class="w-5 h-5 text-gray-800 dark:text-gray-100"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          ></path>
        </svg>
      {:else}
        <svg
          class="w-5 h-5 text-gray-800 dark:text-gray-100"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014.401 18H9.599c-1.385 0-2.626-.711-3.329-1.791l-.548-.547z"
          ></path>
        </svg>
      {/if}
    </button>
  </div>
  <div
    class="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 transition-colors duration-300"
  >
    {#if currentTabId}
      <!-- Language Selector -->
      <div class="mb-4">
        <label
          for="language-select"
          class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >Select Language</label
        >
        <select
          id="language-select"
          bind:value={selectedLanguage}
          disabled={syncState !== "stopped" ||
            isLoadingTranscription ||
            isDownloadProcessActive}
          class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 disabled:opacity-50"
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
        class="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
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
      <p
        class="text-sm text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 p-3 rounded-md text-center"
      >
        Open a YouTube video page to use this extension.
      </p>
    {/if}

    <!-- Error Messages -->
    {#if errorMessage}
      <p
        class="mt-3 text-sm text-red-600 bg-red-100 dark:bg-red-900 dark:text-red-200 p-3 rounded-md"
      >
        {errorMessage}
      </p>
    {/if}
    {#if portError}
      <p
        class="mt-2 text-xs text-red-600 bg-red-100 dark:bg-red-900 dark:text-red-200 p-2 rounded-md"
      >
        {portError}
      </p>
    {/if}

    {#if transcription}
      <!-- Sync Controls -->
      <div class="mt-6">
        <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">
          Synchronized Playback
        </h2>
        {#if syncState !== "stopped" || syncMessage}
          <p
            class="text-sm p-3 rounded-md {syncState === 'error'
              ? 'text-red-600 bg-red-100 dark:bg-red-900 dark:text-red-200'
              : syncState === 'ready' || syncState === 'loading'
                ? 'text-blue-600 bg-blue-100 dark:bg-blue-900 dark:text-blue-200'
                : 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400'}"
          >
            Status: {syncStatusText}
          </p>
        {/if}
        <div class="flex space-x-2 mt-3">
          <button
            on:click={startSyncPlayback}
            disabled={!canStartSync}
            class="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            aria-label="Start synchronized playback"
          >
            Start Sync
          </button>
          <button
            on:click={stopSyncPlayback}
            disabled={!canStopSync}
            class="flex-1 bg-red-600 text-white py-2 px-4 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            aria-label="Stop synchronized playback"
          >
            Stop Sync
          </button>
        </div>
      </div>

      <!-- Download Controls -->
      <div class="mt-6">
        <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">
          Download Audio (WAV)
        </h2>
        {#if syncState !== "stopped"}
          <p
            class="text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 p-2 rounded-md"
          >
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
          class="w-full bg-purple-600 text-white py-2 px-4 rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors mt-2"
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
          <p
            class="mt-2 text-xs text-red-600 bg-red-100 dark:bg-red-900 dark:text-red-200 p-2 rounded-md"
          >
            {downloadError}
          </p>
        {/if}
        {#if downloadState === "preparing"}
          <div class="mt-3">
            <div class="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2.5">
              <div
                class="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                style="width: {(downloadPrepProgress.current /
                  (downloadPrepProgress.total || 1)) *
                  100}%"
              ></div>
            </div>
            <p class="text-xs text-gray-600 dark:text-gray-400 mt-1">
              Progress: {downloadPrepProgress.current}/{downloadPrepProgress.total}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</main>
