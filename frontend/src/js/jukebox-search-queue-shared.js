/**
 * Jukebox search / browse rows: block queue add when the track request is denied, failed, or needs attention.
 */

export function jukeboxSearchTrackBlockedFromQueue(t) {
  if (!t || typeof t !== 'object') {
    return false;
  }
  const d = t.requestDisplayStatus;
  if (d === 'Denied' || d === 'Needs Attention') {
    return true;
  }
  const p = t.requestProcessingStatus;
  if (p === 'Failed' || p === 'Denied') {
    return true;
  }
  const rs = t.requestStatus != null ? String(t.requestStatus).toLowerCase() : '';
  if (rs === 'denied') {
    return true;
  }
  if (rs === 'failed' && !t.requestCancelled) {
    return true;
  }
  return false;
}

export function jukeboxSearchRowStatusIconHtml(t) {
  const Card = window.TrackFlowTrackCard;
  const d = t?.requestDisplayStatus;
  if (!Card || d == null || d === '') {
    return '';
  }
  return Card.statusIconHtmlForList(d);
}

/**
 * @param {string} [title]
 * @param {string} [artist]
 * @param {boolean} playNext
 */
export function confirmJukeboxSearchAddTrack(title, artist, playNext) {
  const name = String(title || 'Track').trim() || 'Track';
  const artRaw = artist != null ? (typeof artist === 'string' ? artist : artist?.name) : '';
  const art = String(artRaw || '').trim();
  const sub = art ? `“${name}” — ${art}` : `“${name}”`;
  const action = playNext ? 'Play this track next?' : 'Add this track to the queue?';
  return window.confirm(`${action}\n\n${sub}`);
}
