/**
 * Sync a followed Deezer playlist to a Plex Media Server playlist for the signed-in Plex user.
 * Requires tracks.plex_rating_key from Plex library scans and users.plex_user_token from Plex sign-in.
 */

const runtimeConfig = require('./runtimeConfig');
const { fetchPlaylistAllTracks } = require('./deezer');
const { getDb } = require('../db');

const db = getDb();

const getPlexRatingKeyStmt = db.prepare(`
  SELECT plex_rating_key FROM tracks
  WHERE trackflow_id = ?
    AND plex_rating_key IS NOT NULL
    AND trim(plex_rating_key) != ''
  LIMIT 1
`);

/**
 * Plex expects one URI with comma-separated ratingKeys in the path (see python-plexapi Playlist._create).
 * Wrong: server://.../metadata/1,server://.../metadata/2
 * Right: server://.../metadata/1,2
 */
function bulkLibraryItemUri(machineId, ratingKeys) {
  const keys = (ratingKeys || []).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) {
    return '';
  }
  return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;
}

async function fetchMachineIdentifier(baseUrl, token) {
  const url = `${baseUrl}/identity`;
  const res = await fetch(url, {
    headers: {
      'X-Plex-Token': token,
      Accept: 'application/xml',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Plex identity failed (${res.status})`);
  }
  const m = text.match(/machineIdentifier="([^"]+)"/i);
  if (!m) {
    throw new Error('Could not read Plex server machine identifier');
  }
  return m[1];
}

function metadataRatingKeyFromJson(data) {
  const meta = data?.MediaContainer?.Metadata;
  const first = Array.isArray(meta) ? meta[0] : meta;
  return first?.ratingKey != null ? String(first.ratingKey) : null;
}

function metadataRatingKeyFromXml(text) {
  const m = String(text || '').match(/ratingKey="(\d+)"/);
  return m ? m[1] : null;
}

/**
 * Regular playlist create matches python-plexapi: POST /playlists?uri=...&type=audio&title=...&smart=0
 * (no section param for non-smart playlists).
 */
async function postPlaylistCreate(baseUrl, token, title, itemUriValue) {
  const qs = new URLSearchParams();
  qs.set('type', 'audio');
  qs.set('title', title);
  qs.set('smart', '0');
  const uri = itemUriValue != null ? String(itemUriValue).trim() : '';
  if (uri) {
    qs.set('uri', uri);
  }
  const url = `${baseUrl}/playlists?${qs.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Plex-Token': token,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const hint = data?.MediaContainer?.title || text?.slice(0, 300) || res.statusText;
    throw new Error(`Plex create playlist failed (${res.status}): ${hint}`);
  }
  let rk = metadataRatingKeyFromJson(data);
  if (!rk && text) {
    rk = metadataRatingKeyFromXml(text);
  }
  if (!rk) {
    throw new Error('Plex create playlist: missing ratingKey in response');
  }
  return rk;
}

async function putPlaylistAddItem(baseUrl, token, playlistRatingKey, itemUriValue) {
  if (!itemUriValue) {
    return;
  }
  const url = `${baseUrl}/playlists/${encodeURIComponent(playlistRatingKey)}/items?uri=${encodeURIComponent(itemUriValue)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'X-Plex-Token': token,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Plex add playlist item failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

async function deletePlexPlaylistByRatingKey(baseUrl, token, ratingKey) {
  const rk = ratingKey != null ? String(ratingKey).trim() : '';
  if (!rk) {
    return;
  }
  const url = `${baseUrl}/playlists/${encodeURIComponent(rk)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-Plex-Token': token },
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    console.warn('[plexPlaylistSync] delete playlist', rk, res.status, t.slice(0, 200));
  }
}

function orderedPlexRatingKeysFromDeezerTracks(deezerTracks) {
  const keys = [];
  if (!Array.isArray(deezerTracks)) {
    return keys;
  }
  for (const t of deezerTracks) {
    const id = t?.id != null ? String(t.id).trim() : '';
    if (!id) {
      continue;
    }
    const row = getPlexRatingKeyStmt.get(id);
    if (row?.plex_rating_key) {
      keys.push(String(row.plex_rating_key).trim());
    }
  }
  return keys;
}

/**
 * Replace remote Plex playlist to match Deezer order; updates followed_playlists.plex_playlist_rating_key.
 * @param {object} fpRow — followed_playlists row (id, playlist_id, title, plex_playlist_rating_key, …)
 * @param {string} userPlexToken — users.plex_user_token
 * @returns {Promise<{ ok: boolean, playlist_rating_key: string|null, tracks_total: number, tracks_mapped: number }>}
 */
async function syncFollowedPlaylistToPlex(fpRow, userPlexToken) {
  const token = userPlexToken != null ? String(userPlexToken).trim() : '';
  if (!token) {
    throw new Error('Missing Plex user token; sign in again with Plex.');
  }

  const { plexUrl } = runtimeConfig.getPlexUrlAndToken();
  const base = plexUrl ? String(plexUrl).replace(/\/+$/, '') : '';
  if (!base) {
    throw new Error('Plex server URL is not configured');
  }

  const playlistTitle = String(fpRow?.title || 'Playlist').trim() || 'Playlist';
  const playlistId = fpRow?.playlist_id != null ? String(fpRow.playlist_id).trim() : '';
  if (!playlistId) {
    throw new Error('Invalid followed playlist row');
  }

  const machineId = await fetchMachineIdentifier(base, token);
  const deezerTracks = await fetchPlaylistAllTracks(playlistId);
  const ratingKeys = orderedPlexRatingKeysFromDeezerTracks(deezerTracks);

  const oldKey = fpRow?.plex_playlist_rating_key != null ? String(fpRow.plex_playlist_rating_key).trim() : '';
  if (oldKey) {
    await deletePlexPlaylistByRatingKey(base, token, oldKey);
  }

  if (ratingKeys.length === 0) {
    db.prepare(
      `UPDATE followed_playlists SET plex_playlist_rating_key = NULL WHERE id = ?`,
    ).run(fpRow.id);
    return {
      ok: true,
      playlist_rating_key: null,
      tracks_total: deezerTracks.length,
      tracks_mapped: 0,
    };
  }

  const bulkUri = bulkLibraryItemUri(machineId, ratingKeys);
  let newRk;
  try {
    newRk = await postPlaylistCreate(base, token, playlistTitle, bulkUri);
  } catch (e) {
    if (ratingKeys.length <= 1) {
      throw e;
    }
    const [firstKey, ...restKeys] = ratingKeys;
    const firstUri = bulkLibraryItemUri(machineId, [firstKey]);
    newRk = await postPlaylistCreate(base, token, playlistTitle, firstUri);
    for (const k of restKeys) {
      const oneUri = bulkLibraryItemUri(machineId, [k]);
      await putPlaylistAddItem(base, token, newRk, oneUri);
    }
  }

  db.prepare(`UPDATE followed_playlists SET plex_playlist_rating_key = ? WHERE id = ?`).run(newRk, fpRow.id);

  return {
    ok: true,
    playlist_rating_key: newRk,
    tracks_total: deezerTracks.length,
    tracks_mapped: ratingKeys.length,
  };
}

/**
 * Remove remote playlist and clear stored rating key (e.g. disable sync or unfollow).
 */
async function removePlexPlaylistForFollowRow(fpRow, userPlexToken) {
  const token = userPlexToken != null ? String(userPlexToken).trim() : '';
  const oldKey = fpRow?.plex_playlist_rating_key != null ? String(fpRow.plex_playlist_rating_key).trim() : '';
  if (!token || !oldKey) {
    return;
  }
  const { plexUrl } = runtimeConfig.getPlexUrlAndToken();
  const base = plexUrl ? String(plexUrl).replace(/\/+$/, '') : '';
  if (!base) {
    return;
  }
  await deletePlexPlaylistByRatingKey(base, token, oldKey);
}

const disableFollowPlexSyncFlagStmt = db.prepare(
  `UPDATE followed_playlists SET plex_sync_enabled = 0 WHERE id = ?`,
);

const clearFollowPlexRatingKeyStmt = db.prepare(
  `UPDATE followed_playlists SET plex_playlist_rating_key = NULL WHERE id = ?`,
);

/**
 * Turn off Plex sync immediately (so plexPlaylistSyncJob skips this row), remove the remote playlist
 * using the in-memory `fpRow` snapshot, then clear the stored rating key. Use when unfollowing or
 * disabling sync before/without deleting the row.
 */
async function teardownPlexSyncForFollowedPlaylist(fpRow, userPlexToken) {
  if (!fpRow?.id) {
    return;
  }
  disableFollowPlexSyncFlagStmt.run(fpRow.id);
  await removePlexPlaylistForFollowRow(fpRow, userPlexToken);
  clearFollowPlexRatingKeyStmt.run(fpRow.id);
}

module.exports = {
  syncFollowedPlaylistToPlex,
  removePlexPlaylistForFollowRow,
  deletePlexPlaylistByRatingKey,
  teardownPlexSyncForFollowedPlaylist,
};
