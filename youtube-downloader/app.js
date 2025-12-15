/**
 * Aplikasi server untuk mengunduh video YouTube.
 * Menggunakan Express.js dan @distube/ytdl-core.
 */

const express = require('express');
const ytdl = require('ytdl-core');
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
 * @function cleanYouTubeUrl
 * @description Membersihkan dan memvalidasi URL YouTube.
 * Mengatasi berbagai format URL, termasuk 'youtu.be' dan URL non-standar.
 * @param {string} url - URL YouTube yang kotor.
 * @returns {string|null} - URL yang bersih dan valid, atau null jika tidak valid.
 */
const cleanYouTubeUrl = (url) => {
  try {
    if (!url) return null;
    
    // Gunakan regex untuk mengekstrak ID video yang valid dari berbagai format URL
    const regExp = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/e\/|youtube\.com\/user\/\w+\/|youtube\.com\/channel\/\w+\/|ytdl-core-legacy\.com\/|ytdl-core\.com\/)([^#&?]{11}).*/;
    const match = url.match(regExp);

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

/**
 * Extract format list dari yt-dlp dengan JSON output
 * Return array of formats dengan detail codec, resolution, size, dll
 */
const getYtdlpFormats = async (url) => {
  try {
    const { spawn } = require('child_process');
    const ytdlpBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
    
    return new Promise((resolve, reject) => {
      const proc = spawn(ytdlpBin, ['-j', url], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0 && output) {
          try {
            const data = JSON.parse(output);
            if (data.formats && Array.isArray(data.formats)) {
              resolve(data.formats);
            } else {
              resolve([]);
            }
          } catch (e) {
            resolve([]);
          }
        } else {
          resolve([]);
        }
      });
      
      proc.on('error', () => reject([]));
    });
  } catch (e) {
    return [];
  }
};

/**
 * Format formats array untuk digunakan di UI
 * Group by resolution dan bitrate
 */
const formatQualityOptions = (formats) => {
  const combined = [];
  const videoOnly = [];
  const audioOnly = [];
  
  if (!Array.isArray(formats)) return { combined, videoOnly, audioOnly };
  
  // Resolution priority untuk sorting
  const resolutionOrder = {
    '2160p': 10, '1440p': 9, '1080p': 8, '720p': 7, '480p': 6, '360p': 5, '240p': 4, '144p': 3
  };
  
  formats.forEach(f => {
    // Format dengan video + audio (combined/muxed)
    if (f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none') {
      const label = f.format_note || f.height ? `${f.height}p` : f.format;
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';
      const ext = f.ext || 'mp4';
      
      // Skip duplicates
      if (!combined.some(c => c.qualityLabel === label)) {
        combined.push({
          itag: f.format_id,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size: size,
          ext: ext
        });
      }
    }
    // Video only
    else if (f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')) {
      const label = f.format_note || f.height ? `${f.height}p (Video Only)` : 'Video Only';
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';
      
      if (!videoOnly.some(v => v.qualityLabel === label)) {
        videoOnly.push({
          itag: f.format_id,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size: size
        });
      }
    }
    // Audio only
    else if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      const bitrate = f.abr ? Math.round(f.abr) : (f.tbr ? Math.round(f.tbr) : 0);
      const label = bitrate > 0 ? `${bitrate} kbps Audio` : 'Audio Only';
      const size = f.filesize ? (f.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';
      
      if (!audioOnly.some(a => a.qualityLabel === label)) {
        audioOnly.push({
          itag: f.format_id,
          qualityLabel: label,
          contentLength: f.filesize || 0,
          size: size
        });
      }
    }
  });
  
  // Sort by resolution
  combined.sort((a, b) => {
    const aRes = Object.keys(resolutionOrder).find(r => a.qualityLabel.includes(r)) || '';
    const bRes = Object.keys(resolutionOrder).find(r => b.qualityLabel.includes(r)) || '';
    return (resolutionOrder[bRes] || 0) - (resolutionOrder[aRes] || 0);
  });
  
  audioOnly.sort((a, b) => {
    const aBit = parseInt(a.qualityLabel) || 0;
    const bBit = parseInt(b.qualityLabel) || 0;
    return bBit - aBit;
  });
  
  return {
    combined: combined.slice(0, 10), // Limit to 10 options
    video: videoOnly.slice(0, 10),
    audio: audioOnly.slice(0, 10)
  };
};

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
        // Coba ytdl-core terlebih dahulu
        const info = await ytdl.getInfo(cleanedUrl);
        console.log('Fetched info; total formats available:', info.formats && info.formats.length);
        
        // Filter and remove duplicate qualities for combined formats, including up to 4K
        const importantVideoQualities = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];
        const combinedFormats = info.formats
            .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio)
            .reduce((unique, o) => {
                if (!unique.some(obj => obj.qualityLabel === o.qualityLabel)) {
                    unique.push(o);
                }
                return unique;
            }, [])
            .sort((a, b) => importantVideoQualities.indexOf(a.qualityLabel) - importantVideoQualities.indexOf(b.qualityLabel));
        
        // Filter and remove duplicate bitrates for audio-only formats
        const audioFormats = info.formats
            .filter(f => f.container === 'mp4' && f.hasAudio && !f.hasVideo)
            .reduce((unique, o) => {
                if (!unique.some(obj => obj.audioBitrate === o.audioBitrate)) {
                    unique.push(o);
                }
                return unique;
            }, [])
            .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
        
        // Filter and separate qualities for video-only formats into HDR and non-HDR
        const videoFormats = info.formats
            .filter(f => f.container === 'mp4' && f.hasVideo && !f.hasAudio && !f.qualityLabel.includes('HDR'))
            .reduce((unique, o) => {
                if (!unique.some(obj => obj.qualityLabel === o.qualityLabel)) {
                    unique.push(o);
                }
                return unique;
            }, [])
            .sort((a, b) => parseInt(b.qualityLabel) - parseInt(a.qualityLabel));
        
        const videoHDRFormats = info.formats
            .filter(f => f.container === 'mp4' && f.hasVideo && !f.hasAudio && f.qualityLabel.includes('HDR'))
            .reduce((unique, o) => {
                if (!unique.some(obj => obj.qualityLabel === o.qualityLabel)) {
                    unique.push(o);
                }
                return unique;
            }, [])
            .sort((a, b) => parseInt(b.qualityLabel) - parseInt(a.qualityLabel));

        // Group all filtered formats
        const allFormats = {
            combined: combinedFormats,
            audio: audioFormats,
            video: videoFormats,
            videoHDR: videoHDRFormats
        };
        console.log('Filtered formats counts:', {
            combined: combinedFormats.length,
            audio: audioFormats.length,
            video: videoFormats.length,
            videoHDR: videoHDRFormats.length
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
                    title: infoJson.title || 'Unknown Title',
                    author: { name: infoJson.uploader || 'Unknown' },
                    lengthSeconds: infoJson.duration || 0,
                    viewCount: infoJson.view_count || 0,
                    thumbnails: [
                        { url: infoJson.thumbnail || '' }
                    ]
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
    const cleanedUrl = cleanYouTubeUrl(url);

    if (!cleanedUrl || !itag) {
        return res.status(400).send('URL atau format tidak valid');
    }

    try {
        console.log('GET /download - url:', url);
        console.log('GET /download - cleanedUrl:', cleanedUrl);
        console.log('GET /download - itag:', itag);

        // First attempt: use ytdl-core
        try {
            const info = await ytdl.getInfo(cleanedUrl);
            const format = ytdl.chooseFormat(info.formats, { quality: itag });
            console.log('GET /download - chosen format:', format ? { itag: format.itag, container: format.container, hasAudio: format.hasAudio, hasVideo: format.hasVideo } : null);

            if (!format) {
                return res.status(400).send('Format tidak tersedia');
            }

            // Sanitasi nama file untuk menghindari karakter ilegal
            const title = info.videoDetails.title
                .replace(/[/\\?%*:|"<>]/g, '')
                .substring(0, 100)
                .trim();

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
        
        const proc = spawn(ytdlpBin, ['-f', fmt, '-o', '-', '--quiet', '--no-warnings', cleanedUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
        
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
        const proc = spawn(ytdlpBin, ['-f', fmt, '-o', '-', '--quiet', '--no-warnings', cleanedUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
        
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
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});