/**
 * Aplikasi server untuk mengunduh video YouTube.
 * Menggunakan Express.js dan @distube/ytdl-core.
 */

const { Blob } = require('buffer');

if (typeof global.File === 'undefined' && typeof Blob !== 'undefined') {
  global.File = class File extends Blob {};
}

const express = require('express');
const ytdl = require('@distube/ytdl-core');
const youtubedl = require('youtube-dl-exec');
const path = require('path');
const app = express();

// Konfigurasi dasar Express
app.set('view engine', 'ejs');
// Menyajikan file statis dari folder 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Menyajikan file statis dari direktori root (tempat sitemap.xml berada)
app.use(express.static(__dirname));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * Argumen extractor untuk yt-dlp.
 * PENTING: sejak YouTube memperketat proteksi PO Token/signature cipher,
 * client 'web' saja sering hanya mengembalikan sedikit format (mis. hanya
 * itag 18 / 360p progresif). Menambahkan client 'android' sebagai fallback
 * membantu yt-dlp mendapatkan daftar format adaptive (720p/1080p/dst) yang
 * lebih lengkap. Konstanta ini dipakai di semua pemanggilan yt-dlp binary
 * agar konsisten antara tahap "ambil daftar format" dan tahap "unduh".
 */
const YTDLP_EXTRACTOR_ARGS = ['--extractor-args', 'youtube:player_client=android_vr,android,web_safari'];

/**
 * @function cleanYouTubeUrl
 * @description Membersihkan dan memvalidasi URL YouTube.
 * Mengatasi berbagai format URL, termasuk 'youtu.be' dan URL non-standar.
 * @param {string} url - URL YouTube yang kotor.
 * @returns {string|null} - URL yang bersih dan valid, atau null jika tidak valid.
 */
const cleanYouTubeUrl = (url) => {
  try {
    if (typeof url !== 'string') return null;

    const trimmedUrl = url.trim();
    if (!trimmedUrl) return null;

    const match = trimmedUrl.match(/(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|v\/|e\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);

    if (match && match[1]) {
      const videoId = match[1];
      if (ytdl.validateID(videoId)) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
};

const getThumbnailUrl = (videoDetails) => {
  if (!videoDetails) return '';

  const thumbnails = Array.isArray(videoDetails.thumbnails) ? videoDetails.thumbnails : [];
  const lastThumbnail = thumbnails[thumbnails.length - 1];
  if (lastThumbnail && lastThumbnail.url) return lastThumbnail.url;

  if (videoDetails.videoId) {
    return `https://img.youtube.com/vi/${videoDetails.videoId}/hqdefault.jpg`;
  }

  return '';
};

const sanitizeFileName = (title) => {
  return String(title || 'video')
    .replace(/[\\/?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) || 'video';
};

const pickAudioFormat = (videoFormat, audioFormats = []) => {
  if (!videoFormat || !Array.isArray(audioFormats) || audioFormats.length === 0) {
    return null;
  }

  return [...audioFormats]
    .filter((format) => format && format.hasAudio && !format.hasVideo)
    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] || null;
};

const hasFfmpeg = () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
  return result.status === 0;
};

const streamMergedDownload = (res, cleanedUrl, formatId, title) => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

  const tempFile = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

  const proc = spawn(ytdlpBin, [
    '-f', formatId,
    '-o', tempFile,
    '--merge-output-format', 'mp4',
    ...YTDLP_EXTRACTOR_ARGS,
    '--quiet',
    '--no-warnings',
    cleanedUrl
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderrOutput = '';
  proc.stderr.on('data', (d) => {
    const msg = d.toString();
    stderrOutput += msg;
    console.error('yt-dlp merge:', msg);
  });

  proc.on('error', (err) => {
    console.error('yt-dlp merge spawn error:', err);
    if (!res.headersSent) res.status(500).send('Gagal menjalankan yt-dlp');
  });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(tempFile)) {
      console.error(`yt-dlp merge exited with code ${code}. Stderr: ${stderrOutput}`);
      if (!res.headersSent) res.status(500).send('Gagal menggabungkan video dan audio');
      return;
    }

    const stat = fs.statSync(tempFile);
    if (stat.size === 0) {
      console.error('yt-dlp merge produced 0-byte file');
      fs.unlink(tempFile, () => {});
      if (!res.headersSent) res.status(500).send('File hasil unduhan kosong');
      return;
    }

    res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
    res.header('Content-Type', 'video/mp4');
    res.header('Content-Length', stat.size);

    const readStream = fs.createReadStream(tempFile);
    readStream.pipe(res);

    const cleanup = () => fs.unlink(tempFile, (err) => {
      if (err) console.error('Gagal hapus temp file:', err);
    });

    readStream.on('close', cleanup);
    readStream.on('error', (err) => {
      console.error('Read stream error:', err);
      cleanup();
      if (!res.headersSent) res.status(500).send('Gagal mengirim file');
    });
    res.on('close', cleanup);
  });
};

/**
 * Extract format list dari yt-dlp dengan JSON output
 * Return array of formats dengan detail codec, resolution, size, dll
 */
const getYtdlpFormats = async (url) => {
  try {
    const { spawn } = require('child_process');
    const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

    return new Promise((resolve, reject) => {
      const proc = spawn(ytdlpBin, [
        '-j',
        ...YTDLP_EXTRACTOR_ARGS,
        url
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errOutput = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (errOutput) {
          console.warn('yt-dlp stderr (format discovery):', errOutput.trim());
        }
        if (code === 0 && output) {
          try {
            const data = JSON.parse(output);
            if (data.formats && Array.isArray(data.formats)) {
              console.log(`yt-dlp found ${data.formats.length} raw formats`);
              resolve(data.formats);
            } else {
              console.warn('yt-dlp JSON had no formats array');
              resolve([]);
            }
          } catch (e) {
            console.error('yt-dlp JSON parse error:', e.message);
            resolve([]);
          }
        } else {
          console.error(`yt-dlp exited with code ${code} during format discovery`);
          resolve([]);
        }
      });

      proc.on('error', (err) => {
        console.error('yt-dlp spawn error (format discovery):', err);
        reject([]);
      });
    });
  } catch (e) {
    console.error('getYtdlpFormats unexpected error:', e);
    return [];
  }
};

/**
 * Format formats array untuk digunakan di UI
 * Group by resolution dan bitrate
 */
const buildDisplayFormats = (formats) => {
  const combined = [];
  const videoOnly = [];
  const audioOnly = [];
  const resolutions = [];

  if (!Array.isArray(formats)) return { combined, videoOnly, audioOnly, resolutions };

  const resolutionOrder = {
    '2160p': 10, '1440p': 9, '1080p': 8, '720p': 7, '480p': 6, '360p': 5, '240p': 4, '144p': 3
  };

  const getResolutionLabel = (format) => {
    const explicitHeight = Number(format.height || format.resolution || format.tbr || format.fps);
    const fallback = format.qualityLabel || format.format_note || format.format || format.mimeType || '';

    if (Number.isFinite(explicitHeight) && explicitHeight > 0) {
      return `${explicitHeight}p`;
    }

    if (typeof fallback === 'string') {
      const match = fallback.match(/(2160|1440|1080|720|480|360|240|144)p?/i);
      if (match) return `${match[1]}p`;
      return fallback;
    }

    return 'Unknown';
  };

  formats.forEach((f) => {
    const isVideo = Boolean(f.hasVideo || (f.vcodec && f.vcodec !== 'none'));
    const isAudio = Boolean(f.hasAudio || (f.acodec && f.acodec !== 'none'));
    const container = (f.container || f.ext || 'mp4').toLowerCase();
    const isMp4Like = container === 'mp4' || container === 'm4a' || container === 'm4v';

    if (isVideo && isAudio && isMp4Like) {
      const label = getResolutionLabel(f);
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';
      const ext = f.ext || 'mp4';

   if (!combined.some((c) => c.qualityLabel === label)) {
        const heightMatch = label.match(/(\d+)p/);
        const option = {
          itag: f.format_id || f.itag,
          height: heightMatch ? parseInt(heightMatch[1], 10) : null,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size,
          ext
        };
        combined.push(option);
        resolutions.push(option);
      }
    } else if (isVideo && !isAudio) {
      // Catatan: sebelumnya kondisi ini mensyaratkan isMp4Like, sehingga
      // format video-only berkualitas tinggi yang dikirim YouTube dalam
      // container webm/vp9 (umum untuk 1080p ke atas) ikut terbuang.
      // Karena unduhan selalu digabung ulang lewat ffmpeg (mode=merged),
      // container asal video-only tidak masalah -- jadi syarat isMp4Like
      // dihapus khusus untuk cabang video-only ini.
      const label = `${getResolutionLabel(f)} (Video Only)`;
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';

    if (!videoOnly.some((v) => v.qualityLabel === label)) {
        const heightMatch = label.match(/(\d+)p/);
        const option = {
          itag: f.format_id || f.itag,
          height: heightMatch ? parseInt(heightMatch[1], 10) : null,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size
        };
        videoOnly.push(option);
        resolutions.push(option);
      }
    } else if (isAudio && !isVideo) {
      const bitrate = f.abr ? Math.round(f.abr) : (f.tbr ? Math.round(f.tbr) : 0);
      const label = bitrate > 0 ? `${bitrate} kbps Audio` : 'Audio Only';
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';

      if (!audioOnly.some((a) => a.qualityLabel === label)) {
        audioOnly.push({
          itag: f.format_id,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size
        });
      }
    }
  });

  const sortResolutions = (items) => items.sort((a, b) => {
    const aRes = Object.keys(resolutionOrder).find((r) => a.qualityLabel.includes(r)) || '';
    const bRes = Object.keys(resolutionOrder).find((r) => b.qualityLabel.includes(r)) || '';
    return (resolutionOrder[bRes] || 0) - (resolutionOrder[aRes] || 0);
  });

  sortResolutions(combined);
  sortResolutions(videoOnly);
  sortResolutions(resolutions);

  audioOnly.sort((a, b) => {
    const aBit = parseInt(a.qualityLabel, 10) || 0;
    const bBit = parseInt(b.qualityLabel, 10) || 0;
    return bBit - aBit;
  });

  return {
    combined: combined.slice(0, 12),
    video: videoOnly.slice(0, 12),
    audio: audioOnly.slice(0, 12),
    resolutions: resolutions.slice(0, 12)
  };
};

const formatQualityOptions = (formats) => buildDisplayFormats(formats);

// Middleware untuk log setiap permintaan masuk
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Rute utama - Menampilkan halaman form unduh
app.get('/', (req, res) => {
    res.render('index', { 
        videoInfo: null, 
        error: null,
        formats: null
    });
});

// Rute POST untuk memproses URL dan menampilkan pilihan unduh (dengan fallback youtube-dl-exec)
app.post('/download', async (req, res) => {
    let url = req.body.url;
    const cleanedUrl = cleanYouTubeUrl(url);
    console.log('POST /download - received URL:', url);
    console.log('POST /download - cleaned URL:', cleanedUrl);
    
    if (!cleanedUrl) {
        return res.render('index', {
            videoInfo: null,
            error: 'URL YouTube tidak valid! Mohon masukkan URL yang benar.',
            formats: null
        });
    }

    try {
        const info = await ytdl.getInfo(cleanedUrl);
        console.log('Fetched info; total formats available:', info.formats && info.formats.length);

        let allFormats = {
            combined: [],
            audio: [],
            video: [],
            videoHDR: [],
            resolutions: []
        };

        const ytdlCoreFormats = buildDisplayFormats(info.formats);
        allFormats = ytdlCoreFormats;

        try {
            const ytdlpFormats = await getYtdlpFormats(cleanedUrl);
            if (Array.isArray(ytdlpFormats) && ytdlpFormats.length > 0) {
                const ytFormats = buildDisplayFormats(ytdlpFormats);
                const ytResCount = ytFormats.resolutions.length;
                const coreResCount = ytdlCoreFormats.resolutions.length;

                if (ytResCount > coreResCount) {
                    allFormats = ytFormats;
                    console.log('Using yt-dlp format list because it has more resolutions than ytdl-core:', {
                        combined: allFormats.combined.length,
                        video: allFormats.video.length,
                        audio: allFormats.audio.length,
                        resolutions: allFormats.resolutions.length
                    });
                } else {
                    console.warn('yt-dlp returned no better resolution list than ytdl-core; using ytdl-core list instead');
                    allFormats = ytdlCoreFormats;
                }
            } else {
                console.warn('yt-dlp returned 0 formats, using ytdl-core list');
                allFormats = ytdlCoreFormats;
            }
        } catch (ytDlpErr) {
            console.warn('yt-dlp format discovery failed, using ytdl-core:', ytDlpErr.message || ytDlpErr);
            allFormats = ytdlCoreFormats;
        }

        if (!allFormats.resolutions.length) {
            const combinedFormats = info.formats
                .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio)
                .reduce((unique, o) => {
                    const label = o.qualityLabel || (o.height ? `${o.height}p` : 'Unknown');
                    if (!unique.some(obj => (obj.qualityLabel || (obj.height ? `${obj.height}p` : 'Unknown')) === label)) {
                        unique.push(o);
                    }
                    return unique;
                }, [])
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            
            const audioFormats = info.formats
                .filter(f => f.hasAudio && !f.hasVideo)
                .reduce((unique, o) => {
                    if (!unique.some(obj => obj.audioBitrate === o.audioBitrate)) {
                        unique.push(o);
                    }
                    return unique;
                }, [])
                .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
            
            const videoFormats = info.formats
                .filter(f => f.hasVideo && !f.hasAudio && !(f.qualityLabel || '').includes('HDR'))
                .reduce((unique, o) => {
                    const label = o.qualityLabel || (o.height ? `${o.height}p` : 'Unknown');
                    if (!unique.some(obj => (obj.qualityLabel || (obj.height ? `${obj.height}p` : 'Unknown')) === label)) {
                        unique.push(o);
                    }
                    return unique;
                }, [])
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            
            const videoHDRFormats = info.formats
                .filter(f => f.hasVideo && !f.hasAudio && (f.qualityLabel || '').includes('HDR'))
                .reduce((unique, o) => {
                    const label = o.qualityLabel || (o.height ? `${o.height}p` : 'Unknown');
                    if (!unique.some(obj => (obj.qualityLabel || (obj.height ? `${obj.height}p` : 'Unknown')) === label)) {
                        unique.push(o);
                    }
                    return unique;
                }, [])
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            allFormats = {
                combined: combinedFormats,
                audio: audioFormats,
                video: videoFormats,
                videoHDR: videoHDRFormats,
                resolutions: [...combinedFormats, ...videoFormats].slice(0, 12)
            };

            console.log('Using ytdl-core fallback format list:', {
                combined: allFormats.combined.length,
                video: allFormats.video.length,
                audio: allFormats.audio.length,
                resolutions: allFormats.resolutions.length
            });
        }

        console.log('Filtered formats counts:', {
            combined: allFormats.combined.length,
            audio: allFormats.audio.length,
            video: allFormats.video.length,
            videoHDR: (allFormats.videoHDR || []).length,
            resolutions: allFormats.resolutions.length
        });
        
        res.render('index', {
            videoInfo: info,
            error: null,
            formats: allFormats
        });
    } catch (err) {
        console.error('ytdl-core error, attempting fallback:', err.message);
        
        // Fallback: gunakan youtube-dl-exec untuk ekstrak info video dan format list
        try {
            // Get basic info
            const proc = await youtubedl.exec(cleanedUrl, { j: true }, { stdio: 'pipe' });
            const infoJson = typeof proc.stdout === 'string' ? JSON.parse(proc.stdout) : proc.stdout;
            
            // Build videoInfo object compatible dengan EJS template
            const videoInfo = {
                videoDetails: {
                    video_url: cleanedUrl,
                    videoId: infoJson.id || '',
                    title: infoJson.title || 'Unknown Title',
                    author: { name: infoJson.uploader || 'Unknown' },
                    lengthSeconds: infoJson.duration || 0,
                    viewCount: infoJson.view_count || 0,
                    thumbnails: [
                        { url: infoJson.thumbnail || '' }
                    ],
                    thumbnailUrl: infoJson.thumbnail || (infoJson.id ? `https://img.youtube.com/vi/${infoJson.id}/hqdefault.jpg` : '')
                }
            };

            console.log('Extracted video info using youtube-dl-exec:', {
                title: videoInfo.videoDetails.title,
                uploader: videoInfo.videoDetails.author.name,
                duration: videoInfo.videoDetails.lengthSeconds
            });
            
            // Get format list dari yt-dlp dengan -j flag
            let formats = await getYtdlpFormats(cleanedUrl);
            console.log('Retrieved', formats.length, 'formats from yt-dlp');
            
            // Format formats untuk UI
            const allFormats = formatQualityOptions(formats);
            console.log('Formatted quality options:', {
                combined: allFormats.combined.length,
                video: allFormats.video.length,
                audio: allFormats.audio.length
            });
            
            res.render('index', {
                videoInfo: videoInfo,
                error: null,
                formats: allFormats
            });
        } catch (fbErr) {
            console.error('Fallback also failed:', fbErr.message);
            
            res.render('index', {
                videoInfo: null,
                error: 'Gagal memproses video. Pastikan URL benar.',
                formats: null
            });
        }
    }
});

// Rute GET untuk memulai unduhan video/audio
app.get('/download', async (req, res) => {
    const url = req.query.url;
    const itag = req.query.itag;
    const resParam = req.query.res;
    const mode = req.query.mode || 'merged';
    const cleanedUrl = cleanYouTubeUrl(url);

    if (!cleanedUrl || !itag) {
        return res.status(400).send('URL atau format tidak valid');
    }

    try {
        console.log('GET /download - url:', url);
        console.log('GET /download - cleanedUrl:', cleanedUrl);
        console.log('GET /download - itag:', itag);
        console.log('GET /download - mode:', mode);

        // Jika mode=merged atau mode=direct dengan itag dari yt-dlp (format_id
        // seperti "137", "251", dll), gunakan langsung jalur yt-dlp.
        // ytdl-core hanya bisa mengenali itag yang berasal dari ekstraksinya
        // sendiri, jadi mencampur itag yt-dlp ke ytdl.chooseFormat() akan
        // gagal/salah pilih format. Untuk mode=direct (audio-only dari
        // yt-dlp), langsung stream pakai yt-dlp juga.
        if (mode === 'merged') {
            const title = sanitizeFileName(cleanedUrl);
            const height = parseInt(resParam, 10);
            const formatSelector = Number.isFinite(height) && height > 0
                ? `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`
                : `${itag}+bestaudio/best`;
            console.log('GET /download merged - formatSelector:', formatSelector);
            streamMergedDownload(res, cleanedUrl, formatSelector, title);
            return;
        }

        if (mode === 'direct') {
            const { spawn } = require('child_process');
            const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

            res.header('Content-Disposition', `attachment; filename="audio.m4a"`);
            const proc = spawn(ytdlpBin, [
                '-f', itag,
                '-o', '-',
                ...YTDLP_EXTRACTOR_ARGS,
                '--quiet',
                '--no-warnings',
                cleanedUrl
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            proc.stderr.on('data', (d) => console.error('yt-dlp direct:', d.toString()));
            proc.on('error', (err) => {
                console.error('yt-dlp direct error:', err);
                if (!res.headersSent) res.status(500).send('Gagal mengunduh audio');
            });
            proc.stdout.pipe(res);
            return;
        }

        // First attempt: use ytdl-core (jalur lama, dipertahankan untuk kompatibilitas)
        try {
            const info = await ytdl.getInfo(cleanedUrl);
            const format = ytdl.chooseFormat(info.formats, { quality: itag });
            console.log('GET /download - chosen format:', format ? { itag: format.itag, container: format.container, hasAudio: format.hasAudio, hasVideo: format.hasVideo } : null);

            if (!format) {
                return res.status(400).send('Format tidak tersedia');
            }

            const title = sanitizeFileName(info.videoDetails.title);

            res.header('Content-Disposition', `attachment; filename="${title}.${format.container || 'mp4'}"`);

            console.log('Starting ytdl-core stream...');
            let attemptedFallback = false;
            const stream = ytdl(cleanedUrl, { quality: itag });
            stream.on('error', (err) => {
                console.error('ytdl-core stream error:', err);
                if (!attemptedFallback) {
                    attemptedFallback = true;
                    console.log('Attempting fallback with youtube-dl-exec...');
                        try {
                        const proc = youtubedl.exec(cleanedUrl, { f: itag }, { stdio: 'pipe' });
                        if (proc && proc.stdout) {
                            proc.stderr.on('data', d => console.error('youtube-dl stderr:', d.toString()));
                            proc.on('error', e => console.error('youtube-dl process error', e));
                            proc.on('close', code => console.log('youtube-dl process closed with', code));
                            proc.stdout.pipe(res);
                        } else {
                            throw new Error('youtube-dl exec did not return a stream');
                        }
                    } catch (e) {
                        console.error('Fallback failed:', e);
                        try { if (!res.headersSent) res.status(500).send('Gagal mengunduh (fallback juga gagal)'); } catch(e){}
                    }
                } else {
                    try { if (!res.headersSent) res.status(500).send('Gagal mengunduh video'); } catch(e){}
                }
            });
            stream.pipe(res);
            return;
        } catch (ytdlErr) {
            console.error('ytdl-core error, falling back to youtube-dl-exec:', ytdlErr.message || ytdlErr);
            // fallthrough to fallback
        }

        // Fallback: use youtube-dl-exec (yt-dlp wrapper) to stream directly
        console.log('Using youtube-dl-exec fallback for streaming...');
        try {
            const proc = youtubedl.exec(cleanedUrl, { f: itag }, { stdio: 'pipe' });
            if (proc && proc.stdout) {
                proc.stderr.on('data', d => console.error('youtube-dl stderr:', d.toString()));
                proc.on('error', e => {
                    console.error('youtube-dl process error', e);
                    try { if (!res.headersSent) res.status(500).send('Gagal mengunduh (fallback error)'); } catch(e){}
                });
                proc.on('close', code => console.log('youtube-dl process closed with', code));
                // Best-effort filename header (user-agent or title extraction would be better)
                res.header('Content-Disposition', `attachment; filename="download.${'mp4'}"`);
                proc.stdout.pipe(res);
                return;
            } else {
                throw new Error('youtube-dl exec did not return a stream');
            }
        } catch (fbErr) {
            console.error('Fallback streaming failed:', fbErr);
            return res.status(500).send('Gagal mengunduh video');
        }
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).send('Gagal mengunduh video');
    }
});

// Simpel endpoints alternatif: download langsung video terbaik atau audio terbaik
app.get('/download/video', async (req, res) => {
    const url = req.query.url;
    const formatId = req.query.fmt; // New: accept specific format_id
    const cleanedUrl = cleanYouTubeUrl(url);
    if (!cleanedUrl) return res.status(400).send('URL tidak valid');

    try {
        // Jika ada format_id spesifik dari UI, gunakan itu, otherwise gunakan format fallback chain
        let fmt = formatId || '96/95/93/18/best[ext=mp4]/best';
        
        res.header('Content-Disposition', 'attachment; filename="video.mp4"');
        const { spawn } = require('child_process');
        const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
        
        const proc = spawn(ytdlpBin, [
            '-f', fmt,
            '-o', '-',
            ...YTDLP_EXTRACTOR_ARGS,
            '--quiet',
            '--no-warnings',
            cleanedUrl
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        console.log('Streaming video with format:', fmt);
        proc.stdout.on('error', e => {
            console.error('stdout error:', e);
            try { if (!res.headersSent) res.status(500).send('Stream error'); } catch(e){}
        });
        proc.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg) console.error('yt-dlp:', msg);
        });
        proc.on('error', e => {
            console.error('yt-dlp process error', e);
            try { if (!res.headersSent) res.status(500).send('Gagal mengunduh video'); } catch(e){}
        });
        proc.on('close', code => {
            if (code !== 0) console.log('yt-dlp video process exited with code', code);
        });
        
        proc.stdout.pipe(res);
    } catch (e) {
        console.error('download/video error:', e);
        res.status(500).send('Gagal mengunduh video');
    }
});

app.get('/download/audio', async (req, res) => {
    const url = req.query.url;
    const formatId = req.query.fmt; // New: accept specific format_id
    const cleanedUrl = cleanYouTubeUrl(url);
    if (!cleanedUrl) return res.status(400).send('URL tidak valid');

    try {
        // Jika ada format_id spesifik dari UI, gunakan itu, otherwise gunakan format fallback
        let fmt = formatId || 'bestaudio[ext=m4a]/bestaudio';
        res.header('Content-Disposition', 'attachment; filename="audio.m4a"');
        const { spawn } = require('child_process');
        const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
        const proc = spawn(ytdlpBin, [
            '-f', fmt,
            '-o', '-',
            ...YTDLP_EXTRACTOR_ARGS,
            '--quiet',
            '--no-warnings',
            cleanedUrl
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        
        console.log('Streaming audio with format:', fmt);
        proc.stdout.on('error', e => {
            console.error('stdout error:', e);
            try { if (!res.headersSent) res.status(500).send('Stream error'); } catch(e){}
        });
        proc.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg) console.error('yt-dlp:', msg);
        });
        proc.on('error', e => {
            console.error('yt-dlp process error', e);
            try { if (!res.headersSent) res.status(500).send('Gagal mengunduh audio'); } catch(e){}
        });
        proc.on('close', code => {
            if (code !== 0) console.log('yt-dlp audio process exited with code', code);
        });
        
        proc.stdout.pipe(res);
    } catch (e) {
        console.error('download/audio error:', e);
        res.status(500).send('Gagal mengunduh audio');
    }
});

// Middleware untuk penanganan error umum
app.use((err, req, res, next) => {
    console.error(err.stack);
    // Mengubah dari res.render('error') ke res.render('index') untuk mengatasi error "Failed to lookup view"
    res.status(500).render('index', { error: 'Terjadi kesalahan server internal.', videoInfo: null, formats: null });
});

// Memulai server
const PORT = process.env.PORT || 3000;
const startServer = (port = PORT) => app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    cleanYouTubeUrl,
    getThumbnailUrl,
    sanitizeFileName,
    pickAudioFormat,
    buildDisplayFormats,
    startServer
};