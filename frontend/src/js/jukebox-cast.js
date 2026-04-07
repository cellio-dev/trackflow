/**
 * Google Cast (Default Media Receiver) for jukebox guest playback.
 * Loads CAF sender only on supported environments (not iOS Safari).
 */

/** @typedef {{ onSessionUiUpdate?: () => void, onCastProgress?: (cur: number, dur: number) => void, onCastPausedSync?: (paused: boolean) => void, onCastTrackFinished?: () => void, onCastFallbackLocal?: () => void }} JukeboxCastCallbacks */

/** @type {JukeboxCastCallbacks} */
let callbacks = {};

/** @type {any} */
let boundMedia = null;
/** @type {((isAlive: boolean) => void) | null} */
let mediaUpdateListener = null;

/** @type {InstanceType<typeof window.cast.framework.RemotePlayer> | null} */
let remotePlayer = null;
/** @type {InstanceType<typeof window.cast.framework.RemotePlayerController> | null} */
let remotePlayerController = null;

let castApiAvailable = false;
let frameworkInitialized = false;
/** Avoid calling fallback on initial NO_SESSION before any Cast session existed. */
let hadCastSession = false;

/** Same value as `chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID` when `chrome` namespace is missing. */
const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';

export function isIOSDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return true;
  }
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

/** Web Cast sender is Chromium-based; Firefox and iOS Safari are unsupported. */
export function shouldOfferCastUi() {
  if (isIOSDevice()) {
    return false;
  }
  const ua = navigator.userAgent || '';
  if (/Firefox\//i.test(ua)) {
    return false;
  }
  return true;
}

export function setJukeboxCastCallbacks(c) {
  callbacks = c && typeof c === 'object' ? c : {};
}

export function isCastFrameworkReady() {
  return castApiAvailable && frameworkInitialized;
}

export function isCasting() {
  try {
    const ctx = window.cast?.framework?.CastContext?.getInstance?.();
    return Boolean(ctx?.getCurrentSession?.());
  } catch {
    return false;
  }
}

export function getCastReceiverLabel() {
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    if (!session) {
      return '';
    }
    const dev = session.getCastDevice?.();
    if (dev?.friendlyName) {
      return dev.friendlyName;
    }
    const sn = session.getSessionObj?.()?.receiver?.friendlyName;
    return sn || '';
  } catch {
    return '';
  }
}

function tearDownMediaListener() {
  if (boundMedia && mediaUpdateListener) {
    try {
      boundMedia.removeUpdateListener(mediaUpdateListener);
    } catch {
      /* ignore */
    }
  }
  boundMedia = null;
  mediaUpdateListener = null;
}

function ensureRemotePlayer() {
  if (!window.cast?.framework || remotePlayer) {
    return;
  }
  try {
    remotePlayer = new window.cast.framework.RemotePlayer();
    remotePlayerController = new window.cast.framework.RemotePlayerController(remotePlayer);
    remotePlayerController.addEventListener(
      window.cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
      () => {
        if (!isCasting() || !remotePlayer) {
          return;
        }
        const cur = remotePlayer.currentTime;
        const dur = remotePlayer.duration;
        if (typeof callbacks.onCastProgress === 'function' && Number.isFinite(cur) && Number.isFinite(dur) && dur > 0) {
          callbacks.onCastProgress(cur, dur);
        }
      },
    );
    remotePlayerController.addEventListener(
      window.cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
      () => {
        if (!isCasting() || !remotePlayer) {
          return;
        }
        if (typeof callbacks.onCastPausedSync === 'function') {
          callbacks.onCastPausedSync(Boolean(remotePlayer.isPaused));
        }
      },
    );
  } catch {
    remotePlayer = null;
    remotePlayerController = null;
  }
}

function onMediaStatusUpdate(isAlive) {
  if (!isAlive || !boundMedia) {
    return;
  }
  try {
    const idle = boundMedia.playerState === window.chrome.cast.media.PlayerState.IDLE;
    const finished = boundMedia.idleReason === window.chrome.cast.media.IdleReason.FINISHED;
    if (idle && finished && typeof callbacks.onCastTrackFinished === 'function') {
      callbacks.onCastTrackFinished();
    }
  } catch {
    /* ignore */
  }
}

export function initCastFrameworkOptions() {
  if (!castApiAvailable || frameworkInitialized) {
    return;
  }
  if (!window.cast?.framework?.CastContext?.getInstance) {
    return;
  }
  try {
    const ctx = window.cast.framework.CastContext.getInstance();
    const appId =
      window.chrome?.cast?.media?.DEFAULT_MEDIA_RECEIVER_APP_ID ?? DEFAULT_MEDIA_RECEIVER_APP_ID;
    const autoJoinPolicy = window.chrome?.cast?.AutoJoinPolicy?.ORIGIN_SCOPED;
    if (autoJoinPolicy != null) {
      ctx.setOptions({
        receiverApplicationId: appId,
        autoJoinPolicy,
      });
    } else {
      try {
        ctx.setOptions({
          receiverApplicationId: appId,
          autoJoinPolicy: 'origin_scoped',
        });
      } catch {
        ctx.setOptions({ receiverApplicationId: appId });
      }
    }
    ctx.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, () => {
      if (typeof callbacks.onSessionUiUpdate === 'function') {
        callbacks.onSessionUiUpdate();
      }
      const sess = ctx.getCurrentSession();
      if (!sess) {
        tearDownMediaListener();
        remotePlayer = null;
        remotePlayerController = null;
        if (hadCastSession && typeof callbacks.onCastFallbackLocal === 'function') {
          callbacks.onCastFallbackLocal();
        }
        hadCastSession = false;
      } else {
        hadCastSession = true;
        ensureRemotePlayer();
      }
    });
    frameworkInitialized = true;
    ensureRemotePlayer();
  } catch {
    frameworkInitialized = false;
  }
}

/**
 * Wait for Cast SDK (loaded from HTML before this module per Google integration order).
 * Does not inject a second copy of cast_sender.js.
 * @returns {Promise<boolean>} true if Cast API is available in this browser
 */
export function loadCastSenderScript() {
  const applyReady = () => {
    const ok = !!window.__tfCastApiAvailable;
    castApiAvailable = ok;
    if (ok) {
      initCastFrameworkOptions();
    }
    return ok;
  };

  if (window.__tfCastApiReadyResolved) {
    return Promise.resolve(applyReady());
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(applyReady());
    };

    const onReady = () => {
      window.removeEventListener('tf-cast-api-ready', onReady);
      clearTimeout(timeoutId);
      finish();
    };

    window.addEventListener('tf-cast-api-ready', onReady);

    const timeoutId = setTimeout(() => {
      window.removeEventListener('tf-cast-api-ready', onReady);
      if (!window.__tfCastApiReadyResolved) {
        window.__tfCastApiAvailable = false;
        window.__tfCastApiReadyResolved = true;
      }
      finish();
    }, 15000);

    if (window.__tfCastApiReadyResolved) {
      onReady();
    }
  });
}

/**
 * Open the Cast device picker. Must run synchronously inside a user gesture (pointerdown/click).
 *
 * Chrome may open Global Media Controls instead of the Cast picker when Media Session metadata
 * is tied to playing audio. We briefly clear metadata, prefer chrome.cast.requestSession
 * (base API), then fall back to CastContext.requestSession().
 */
export function requestCastSessionFromUserGesture() {
  if (!frameworkInitialized || !castApiAvailable) {
    return;
  }

  const ms = navigator.mediaSession;
  /** @type {MediaMetadata | null} */
  let savedMeta = null;
  try {
    if (ms && ms.metadata != null) {
      savedMeta = ms.metadata;
      ms.metadata = null;
    }
  } catch {
    /* ignore */
  }

  const restoreMeta = () => {
    try {
      if (ms && savedMeta != null) {
        ms.metadata = savedMeta;
      }
    } catch {
      /* ignore */
    }
  };

  try {
    const cc = window.chrome?.cast;
    if (typeof cc?.requestSession === 'function') {
      cc.requestSession(
        () => {},
        () => {},
      );
    } else {
      const ctx = window.cast?.framework?.CastContext?.getInstance?.();
      if (ctx && typeof ctx.requestSession === 'function') {
        void ctx.requestSession();
      }
    }
  } catch {
    try {
      const ctx = window.cast?.framework?.CastContext?.getInstance?.();
      if (ctx && typeof ctx.requestSession === 'function') {
        void ctx.requestSession();
      }
    } catch {
      /* ignore */
    }
  }

  setTimeout(restoreMeta, 400);
}

export async function requestCastSession() {
  const ctx = window.cast?.framework?.CastContext?.getInstance?.();
  if (!ctx) {
    return;
  }
  try {
    await ctx.requestSession();
  } catch {
    /* user cancelled or error */
  }
}

export function endCastSession() {
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    session?.endSession(true);
  } catch {
    /* ignore */
  }
  tearDownMediaListener();
  remotePlayer = null;
  remotePlayerController = null;
}

/** Stop current receiver media but keep the Cast session (e.g. jukebox idle). */
export function castStopMediaIfAny() {
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    const media = session?.getMediaSession?.();
    if (media) {
      media.stop(() => {}, () => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ streamUrl: string, title?: string, artist?: string, autoplay?: boolean, contentType?: string }} opts
 */
export async function loadStreamOnCast(opts) {
  const { streamUrl, title, artist, autoplay = true, contentType = 'audio/mpeg' } = opts;
  const ctx = window.cast?.framework?.CastContext?.getInstance?.();
  const session = ctx?.getCurrentSession?.();
  if (!session || !window.chrome?.cast?.media) {
    return false;
  }
  tearDownMediaListener();
  try {
    const mediaInfo = new window.chrome.cast.media.MediaInfo(streamUrl, contentType);
    mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED;
    if (window.chrome.cast.media.MusicTrackMediaMetadata) {
      const meta = new window.chrome.cast.media.MusicTrackMediaMetadata();
      meta.metadataType = window.chrome.cast.media.MetadataType.MUSIC_TRACK;
      meta.title = title || 'Track';
      meta.artist = artist || '';
      mediaInfo.metadata = meta;
    }
    const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = autoplay;
    await session.loadMedia(request);
    const media = session.getMediaSession?.();
    if (media) {
      boundMedia = media;
      mediaUpdateListener = onMediaStatusUpdate;
      media.addUpdateListener(mediaUpdateListener);
      if (!autoplay) {
        media.pause(() => {}, () => {});
      }
    }
    ensureRemotePlayer();
    return true;
  } catch {
    endCastSession();
    return false;
  }
}

/**
 * Align receiver play/pause with server jukebox state (polling updates).
 * @param {boolean} wantPaused
 */
export function castSetPaused(wantPaused) {
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    const media = session?.getMediaSession?.();
    if (!media || !window.chrome?.cast?.media) {
      return;
    }
    const ps = media.playerState;
    const playing = ps === window.chrome.cast.media.PlayerState.PLAYING;
    const paused = ps === window.chrome.cast.media.PlayerState.PAUSED;
    if (wantPaused && playing) {
      media.pause(() => {}, () => {});
    } else if (!wantPaused && paused) {
      media.play(() => {}, () => {});
    }
  } catch {
    /* ignore */
  }
}

export function castPlayPauseToggle() {
  try {
    if (remotePlayerController) {
      remotePlayerController.playOrPause();
      return;
    }
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    const media = session?.getMediaSession?.();
    if (!media) {
      return;
    }
    if (media.playerState === window.chrome.cast.media.PlayerState.PLAYING) {
      media.pause(() => {}, () => {});
    } else {
      media.play(() => {}, () => {});
    }
  } catch {
    /* ignore */
  }
}

export function castSetReceiverVolume(level01) {
  const v = Math.min(1, Math.max(0, Number(level01) || 0));
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    if (!session) {
      return;
    }
    if (typeof session.setVolume === 'function') {
      session.setVolume(v);
      return;
    }
    const chromeSession = session.getSessionObj?.();
    if (chromeSession?.setReceiverVolume) {
      chromeSession.setReceiverVolume(v, false, () => {}, () => {});
    }
  } catch {
    /* ignore */
  }
}

/** Seek the current Cast media to `seconds` (buffered audio stream). */
export function castSeekTo(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  try {
    const session = window.cast.framework.CastContext.getInstance().getCurrentSession();
    const media = session?.getMediaSession?.();
    const cc = window.chrome?.cast?.media;
    if (!media || !cc?.SeekRequest) {
      return;
    }
    const req = new cc.SeekRequest();
    req.currentTime = t;
    media.seek(req, () => {}, () => {});
  } catch {
    /* ignore */
  }
}

export function updateVolumeUiFromCast() {
  try {
    if (remotePlayer && Number.isFinite(remotePlayer.volumeLevel)) {
      return Math.min(1, Math.max(0, remotePlayer.volumeLevel));
    }
  } catch {
    /* ignore */
  }
  return null;
}
