/**
 * Single global Deezer preview player (shared by track lists and search cards).
 */
(function (global) {
  let currentAudio = null;
  let currentTrackId = null;
  let onStopCallback = null;

  function stop() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
    const cb = onStopCallback;
    currentAudio = null;
    currentTrackId = null;
    onStopCallback = null;
    if (typeof cb === 'function') {
      cb();
    }
  }

  /**
   * @param {string} url
   * @param {string} trackId
   * @param {() => void} onStart
   * @param {() => void} onStopForThis - invoked when this preview stops (user, ended, or another track)
   */
  function toggle(url, trackId, onStart, onStopForThis) {
    if (currentTrackId === trackId && currentAudio) {
      stop();
      return;
    }
    stop();

    const audio = new Audio(url);
    currentAudio = audio;
    currentTrackId = trackId;
    onStopCallback = onStopForThis;
    onStart();

    audio.onended = () => {
      if (currentAudio === audio) {
        stop();
      }
    };

    audio.play().catch((error) => {
      console.error('Preview playback failed:', error);
      stop();
    });
  }

  function isPlaying(trackId) {
    return currentTrackId === trackId && currentAudio != null;
  }

  global.TrackFlowTrackPreview = { toggle, stop, isPlaying };
})(typeof window !== 'undefined' ? window : globalThis);
