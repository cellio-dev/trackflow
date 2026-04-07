// Placeholder route for search.
// Keep this file thin; move the real search logic into `services/` later.

const express = require('express');
const deezer = require('../services/deezer');

const router = express.Router();

const SEARCH_RESULTS_PER_CATEGORY = 20;

const { enrichDeezerTrackRows } = require('../services/searchTrackEnrichment');

async function addTrackAvailability(tracksPayload) {
  const tracks = Array.isArray(tracksPayload?.results) ? tracksPayload.results : [];
  const results = await enrichDeezerTrackRows(tracks);
  return { results };
}

// GET /api/search
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();

  if (!q) {
    return res.status(400).json({
      error: 'Query parameter "q" is required',
    });
  }

  const settled = await Promise.allSettled([
    deezer.searchTracks(q),
    deezer.searchArtists(q),
    deezer.searchAlbums(q),
    deezer.searchPlaylists(q),
  ]);

  function resultsFromSettled(entry, label) {
    if (entry.status === 'fulfilled') {
      const r = entry.value?.results;
      return Array.isArray(r) ? r : [];
    }
    console.error(`Search ${label} failed:`, entry.reason?.message || entry.reason);
    return [];
  }

  const trackRows = resultsFromSettled(settled[0], 'tracks').slice(0, SEARCH_RESULTS_PER_CATEGORY);
  const artists = resultsFromSettled(settled[1], 'artists').slice(0, SEARCH_RESULTS_PER_CATEGORY);
  const albums = resultsFromSettled(settled[2], 'albums').slice(0, SEARCH_RESULTS_PER_CATEGORY);
  const playlists = resultsFromSettled(settled[3], 'playlists').slice(
    0,
    SEARCH_RESULTS_PER_CATEGORY,
  );

  let tracksOut = trackRows.map((t) => ({
    ...t,
    existsInMusicLibrary: false,
    existsInPlex: false,
    isInUserLibrary: false,
    requestStatus: null,
    requestId: null,
    requestPlexStatus: null,
    requestDisplayStatus: null,
    requestProcessingStatus: null,
  }));

  try {
    if (trackRows.length > 0) {
      const enriched = await addTrackAvailability({ results: trackRows });
      tracksOut = enriched.results;
    }
  } catch (error) {
    console.error('Search track availability failed:', error.message);
  }

  return res.json({
    tracks: tracksOut,
    artists,
    albums,
    playlists,
  });
});

// GET /api/search/album/:id
router.get('/album/:id', async (req, res) => {
  const id = (req.params.id || '').trim();

  if (!id) {
    return res.status(400).json({
      error: 'Album id is required',
    });
  }

  try {
    const albumData = await deezer.getAlbumTracks(id);
    const enrichedTracks = await addTrackAvailability({ results: albumData.tracks });
    return res.json({
      result: {
        albumTitle: albumData.albumTitle,
        artist: albumData.artist,
        artistId: albumData.artistId,
        cover: albumData.cover,
        tracks: enrichedTracks.results,
      },
    });
  } catch (error) {
    console.error('Album tracks failed:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch Deezer album',
    });
  }
});

// GET /api/search/playlist/:id
router.get('/playlist/:id', async (req, res) => {
  const id = (req.params.id || '').trim();

  if (!id) {
    return res.status(400).json({
      error: 'Playlist id is required',
    });
  }

  try {
    const playlistData = await deezer.getPlaylist(id);
    const enrichedTracks = await addTrackAvailability({ results: playlistData.tracks });
    return res.json({
      result: {
        id: playlistData.id,
        title: playlistData.title,
        picture: playlistData.picture,
        tracks: enrichedTracks.results,
      },
    });
  } catch (error) {
    console.error('Playlist failed:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch Deezer playlist',
    });
  }
});

// GET /api/search/artist/:id/albums
router.get('/artist/:id/albums', async (req, res) => {
  const id = (req.params.id || '').trim();

  if (!id) {
    return res.status(400).json({
      error: 'Artist id is required',
    });
  }

  try {
    const albums = await deezer.getArtistAlbums(id);
    return res.json({ results: albums });
  } catch (error) {
    console.error('Artist albums failed:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch Deezer artist albums',
    });
  }
});

// GET /api/search/artist/:id
router.get('/artist/:id', async (req, res) => {
  const id = (req.params.id || '').trim();

  if (!id) {
    return res.status(400).json({
      error: 'Artist id is required',
    });
  }

  try {
    const [tracksPayload, artistSettled] = await Promise.allSettled([
      deezer.getArtistTopTracks(id),
      deezer.getArtistById(id),
    ]);
    if (tracksPayload.status !== 'fulfilled') {
      throw tracksPayload.reason;
    }
    const resultsWithAvail = await addTrackAvailability(tracksPayload.value);
    const artist = artistSettled.status === 'fulfilled' ? artistSettled.value : null;
    return res.json({
      ...resultsWithAvail,
      artist,
    });
  } catch (error) {
    console.error('Artist top tracks failed:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch Deezer artist top tracks',
    });
  }
});

module.exports = router;

