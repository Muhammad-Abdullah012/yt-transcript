<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { ACTION } from "../../constants";
  import { formatTranscript } from "@/lib/scrapTranscript";
  import {
    AudioQueueManager,
    individualAudioQueueStore,
    playbackStateStore,
   } from "@/lib/audioQueueManager";

  interface TranscriptSegment {
    timestamp: string;
    text: string;
  }

  let transcription: TranscriptSegment[] | null = null;
  
  let audioPort: Browser.runtime.Port | null = null;
  const audioQueue = new AudioQueueManager(); // Instantiate the manager
  let isLoadingTranscription = false; // More specific loading state
  let isStreamingAudio = false; // Tracks if background is sending chunks
  let errorMessage: string | null = null;
  let currentTabId: number | null = null;
  let isDownloading = false;
  let downloadError: string | null = null;

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
      } else {
        errorMessage = "Not on an active YouTube video page.";
        console.log("Popup not opened on an active YouTube watch page.");
      }
    } catch (error) {
      console.error("Error querying tabs:", error);
      errorMessage = "Error finding YouTube tab. Check console.";
    }
  });

  onDestroy(() => {
    if (audioPort) {
      audioPort.disconnect();
      audioPort = null;
    }
    // Optional: Stop audio if popup closes during playback
    // audioQueue.stop();
    // Consider if you want audio to continue if popup is closed briefly
  });

  // --- Transcription ---
  async function getTranscription() {
    if (!currentTabId) {
      errorMessage = "Cannot find the active YouTube tab.";
      return;
    }

    isLoadingTranscription = true;
    errorMessage = null;
    transcription = null;
    audioQueue.clearAllAudio(); // Clear previous audio if getting new transcript

    console.log(`Sending ${ACTION.GET_TRANSCRIPTION} to tab ${currentTabId}`);

    try {
      const response = await browser.tabs.sendMessage(currentTabId, {
        action: ACTION.GET_TRANSCRIPTION,
      });

      console.log("Response received from content script:", response);

      if (response?.action === ACTION.TRANSCRIPTION_RESULT) {
        transcription = response.payload;
        // Automatically start streaming after getting transcript? Or keep separate?
        // Let's keep it separate for now via the "Play Full Audio" button.
      } else if (response?.action === ACTION.TRANSCRIPTION_ERROR) {
        errorMessage = `Error: ${response.payload}`;
      } else {
        errorMessage = response
          ? "Received an unexpected response from content script."
          : "No response from content script. Try reloading the YouTube page and the extension.";
        console.error("Unexpected response:", response);
      }
    } catch (error: any) {
      console.error("Error sending message or receiving response:", error);
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
      isLoadingTranscription = false;
    }
  }

  function requestAudioStream() {
    if (!transcription || isStreamingAudio || $playbackStateStore !== 'stopped') return; // Don't start if already streaming/playing/paused

    isStreamingAudio = true; // Indicate that we are waiting for chunks
    errorMessage = null;
    audioQueue.clearAllAudio(); // Clear any previous state before starting fresh

    // Clean up any previous port
    if (audioPort) {
      audioPort.disconnect();
    }

    // Connect to background
    console.log("Connecting to background script for audio stream...");
    audioPort = browser.runtime.connect(); // Assumes default connection (to background)

    // Handle potential connection errors immediately
    if (browser.runtime.lastError) {
        console.error("Error connecting to background:", browser.runtime.lastError.message);
        errorMessage = `Connection Error: ${browser.runtime.lastError.message}`;
        isStreamingAudio = false;
        audioPort = null;
        return;
    }


    audioPort.postMessage({
      action: ACTION.START_AUDIO_STREAM,
      payload: {
        transcription,
        language: "Italian", // Or make dynamic if needed
      },
    });

    // Listen for messages
    audioPort.onMessage.addListener(handleAudioMessage);
    audioPort.onDisconnect.addListener(handleAudioDisconnect);
  }

  function handleAudioMessage(msg: any) {
      if (!audioPort) return; // Port might have disconnected

      if (msg.type === ACTION.AUDIO_CHUNK) {
        console.log("Received chunk", msg.index);
        // Add the chunk. Playback won't start automatically here.
        audioQueue.add(msg.audioContent, msg.text);
        
        if (msg.index === 0 && $playbackStateStore === 'stopped') {
           audioQueue.play();
        }
      } else if (msg.type === ACTION.STREAM_COMPLETE) {
        console.log("All audio chunks received.");
        isStreamingAudio = false; // Streaming finished
        // Playback continues via the AudioQueueManager's internal logic
        // Disconnect the port now that the stream is complete
        if (audioPort) {
            audioPort.disconnect();
            audioPort = null;
        }
      } else if (msg.type === ACTION.ERROR) {
        console.error("Error message from background audio stream:", msg.payload);
        errorMessage = `Audio Stream Error: ${msg.payload}`;
        isStreamingAudio = false;
        audioQueue.stop(); // Stop playback on error
        if (audioPort) {
            audioPort.disconnect();
            audioPort = null;
        }
      }
  }

 function handleAudioDisconnect() {
    if (!audioPort) return; // Already handled disconnect
    console.log("Background port disconnected.");
     // Check if disconnect was expected (e.g., after STREAM_COMPLETE) or unexpected
    if (isStreamingAudio) {
        console.warn("Audio port disconnected unexpectedly during streaming.");
        errorMessage = "Audio stream interrupted unexpectedly.";
        audioQueue.stop(); // Stop playback if stream was cut short
    }
    isStreamingAudio = false;
    audioPort = null; // Clear the port reference
 }

  // Combined Play/Pause/Resume handler for the main button
  function toggleFullPlayback() {
    const currentState = $playbackStateStore;

    if (currentState === 'playing') {
      audioQueue.pause();
    } else if (currentState === 'paused') {
      audioQueue.play(); // Resume
    } else if (currentState === 'stopped') {
      // If stopped, check if we need to request the stream first
      if ($individualAudioQueueStore.length === 0 && transcription) {
         // Need to get the audio first, then play
         requestAudioStream();
         // We need a slight delay or a mechanism to start play()
         // once the first chunk arrives. Let's modify handleAudioMessage.
         // For simplicity now, let's assume user clicks again after loading.
         // A better UX would auto-play after loading finishes.
         // Let's refine: Start stream, then immediately call play.
         // The manager will wait for the first chunk if needed.
         requestAudioStream(); // Request the stream
         // Set a flag or use a promise to know when the first chunk is added?
         // Let's try calling play directly. The manager should handle it.
         audioQueue.play(); // Attempt to start playback

      } else if ($individualAudioQueueStore.length > 0) {
         // Audio already loaded, just play from beginning
         audioQueue.play();
      }
    }
  }

  // --- Individual Segment Control ---
  function playIndividualAudio(index: number) {
    // Pauses the main queue automatically within playIndividual
    audioQueue.playIndividual(index);
  }

  function pauseIndividualAudio(index: number) {
    audioQueue.pauseIndividual(index);
  }

  // --- Download ---
  async function downloadAudio() {
    if (!audioQueue.hasAnyAudio() || isDownloading) {
      return;
    }

    isDownloading = true;
    downloadError = null;

    try {
      const blob = await audioQueue.getFullAudio(); // Await the promise

      if (blob.size === 0) {
          console.warn("No audio data generated or fetched for download.");
          downloadError = "No audio data available to download.";
          return;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Suggest a filename based on video title later?
      a.download = 'youtube_transcript_audio.wav';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Error downloading audio:", error);
      downloadError = "Failed to prepare audio for download. Check console.";
    } finally {
      isDownloading = false;
    }
  }

  // --- Reactive Computations ---
  $: hasAudioSegments = $individualAudioQueueStore.length > 0;
  $: canGetTranscription = !isLoadingTranscription && !!currentTabId;
  $: canControlPlayback = hasAudioSegments || (transcription && !isStreamingAudio); // Can start if transcript exists
  $: canDownload = hasAudioSegments && !isDownloading;

  $: playButtonText =
    $playbackStateStore === 'playing' ? 'Pause Full Audio' :
    $playbackStateStore === 'paused' ? 'Resume Full Audio' :
    'Play Full Audio';

</script>

<main>
  <h1>YouTube Transcript & Audio</h1>
  <div class="card">
    {#if currentTabId}
      <button onclick={getTranscription} disabled={!canGetTranscription}>
        {#if isLoadingTranscription}
          Loading Transcript...
        {:else}
          Get Transcription
        {/if}
      </button>
    {:else if !errorMessage}
      <p class="message info">
        Open a YouTube video page to use this extension.
      </p>
    {/if}

    {#if errorMessage}
      <p class="message error">Error: {errorMessage}</p>
    {/if}

    {#if transcription}
      <textarea class="message transcript-area" readonly
        >{formatTranscript(transcription)}</textarea
      >
      <button
        onclick={toggleFullPlayback}
        disabled={!canControlPlayback || isStreamingAudio}
        title={isStreamingAudio ? "Audio is currently loading..." : ""}
      >
        {#if isStreamingAudio}
            Loading Audio...
        {:else}
            {playButtonText}
        {/if}
      </button>

      <!-- Download Button -->
      <button
        onclick={downloadAudio}
        disabled={!canDownload}
      >
        {#if isDownloading}
            Downloading...
        {:else}
            Download Full Audio (.wav)
        {/if}
      </button>
       {#if downloadError}
         <p class="message error small-error">Download Error: {downloadError}</p>
       {/if}

      <!-- Individual Segment List -->
      {#if hasAudioSegments}
        <h2>Individual Segments</h2>
        <ul class="segment-list">
          {#each $individualAudioQueueStore as { text, index }}
            <li class="segment-item">
               <div class="segment-controls">
                 <button class="small-button" onclick={() => playIndividualAudio(index)} title="Play this segment">
                   ▶ Play
                 </button>
                 <button class="small-button" onclick={() => pauseIndividualAudio(index)} title="Pause this segment">
                   ❚❚ Pause
                 </button>
               </div>
               <span class="segment-text">{index + 1}. {text}</span>
            </li>
          {/each}
        </ul>
      {/if}

    {/if}
  </div>
</main>

<style>
  main {
    font-family: sans-serif;
    padding: 1em;
    min-width: 350px; /* Slightly wider */
    max-width: 500px;
  }
  .card {
    border: 1px solid #ccc;
    padding: 1em;
    border-radius: 4px;
  }
  button {
    padding: 0.6em 1.2em;
    cursor: pointer;
    margin: 0.5em 0.5em 0.5em 0; /* Add some spacing */
    border: 1px solid #aaa;
    border-radius: 4px;
    /* background-color: #eee; */
    font-size: 0.9rem;
  }
  button:hover:not(:disabled) {
     /* background-color: #ddd; */
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .message {
    margin-top: 1em;
    margin-bottom: 1em;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 0.9em;
    max-height: 250px;
    overflow-y: auto;
    border: 1px solid #eee;
    padding: 0.5em;
    background-color: #f9f9f9;
    color: #333;
    border-radius: 3px;
  }
  .transcript-area {
    width: 95%;
    min-height: 100px; /* Adjust as needed */
    resize: vertical;
  }
  .error {
    color: #a94442;
    border-color: #ebccd1;
    background-color: #f2dede;
  }
   .small-error {
      font-size: 0.8em;
      padding: 0.3em;
      margin-top: 0.2em;
   }
  .info {
    color: #31708f;
    background-color: #f0f0f0;
    border-color: #bce8f1;
  }
  h1, h2 {
      margin-top: 0;
      margin-bottom: 0.5em;
      /* color: #333; */
  }
  h2 {
      font-size: 1.1em;
      border-top: 1px solid #eee;
      padding-top: 0.8em;
      margin-top: 1em;
  }
  .segment-list {
      list-style: none;
      padding: 0;
      margin: 0;
      max-height: 200px; /* Limit list height */
      overflow-y: auto;
      border: 1px solid #eee;
      border-radius: 3px;
  }
  .segment-item {
      display: flex;
      align-items: center;
      padding: 0.4em 0.6em;
      border-bottom: 1px solid #eee;
      font-size: 0.85em;
  }
  .segment-item:last-child {
      border-bottom: none;
  }
  .segment-controls {
      margin-right: 0.8em;
      flex-shrink: 0; /* Prevent controls from shrinking */
  }
  .segment-text {
      flex-grow: 1;
      word-break: break-word; /* Break long words if needed */
  }
  .small-button {
      padding: 0.2em 0.5em;
      font-size: 0.8em;
      margin-right: 0.3em;
  }
</style>