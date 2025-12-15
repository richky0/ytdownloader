# YouTube Downloader

A fast, free, and unlimited YouTube video and audio downloader built with Node.js and Express.js. Download videos in multiple resolutions (up to 1080p) and extract audio in various quality options.

**Created by:** Richky Sung

## ✨ Features

- 🎬 **Download Videos** in multiple resolutions (1080p, 720p, 480p, 360p, 240p, 144p)
- 🎵 **Extract Audio** in various bitrate qualities (130kbps, 128kbps, and more)
- ⚡ **High-Speed Downloads** - Optimized streaming for fast downloads
- 🎯 **Smart Format Selection** - Automatically selects best available quality
- 📱 **Responsive UI** - Mobile-friendly dark theme interface
- 🔄 **Automatic Fallback** - Multiple format fallback chains ensure reliability
- 🌐 **Zero Registration** - No account needed, completely free to use
- 📊 **Real-Time Format Information** - Shows available resolutions before download

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)
- yt-dlp binary (automatically installed with youtube-dl-exec)

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/yourusername/youtube-downloader.git
cd youtube-downloader
```

2. **Install dependencies**
```bash
npm install
```

3. **Start the server**
```bash
npm start
```

The application will be available at `http://localhost:3000`

## 📖 Usage

### Web Interface

1. Open `http://localhost:3000` in your browser
2. Paste a YouTube URL in the input field
3. Click **Submit** or press Enter
4. Select your preferred:
   - **Video Resolution** (1080p, 720p, 480p, 360p, 240p, 144p)
   - **Audio Quality** (various bitrate options: 130kbps, 128kbps, etc.)
5. Click the download button for your choice
6. File will start downloading automatically

### Supported URL Formats

The downloader supports various YouTube URL formats:
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`
- And other YouTube URL variations

## 🛠️ Using Your Own YouTube API

This application uses **yt-dlp** (a fork of youtube-dl) as the primary downloader backend. If you want to replace the current API/backend with your own YouTube API, follow these steps:

### Step 1: Choose Your API Provider

You can use:
- **YouTube Data API v3** (Official Google API)
- **pytube** (Python library)
- **youtube-dl / yt-dlp** (CLI tool - currently used)
- **Custom API** (Your own implementation)

### Step 2: Update the Backend

The main download logic is in `app.js`. Key functions to modify:

**For `/download/video` endpoint (line ~426):**
```javascript
app.get('/download/video', async (req, res) => {
    const url = req.query.url;
    const formatId = req.query.fmt;
    const cleanedUrl = cleanYouTubeUrl(url);
    
    // REPLACE THIS SECTION with your API call
    // Currently uses: spawn(ytdlpBin, ['-f', fmt, '-o', '-', ...])
    // 
    // Example with custom API:
    // const videoStream = await yourCustomAPI.getVideoStream(cleanedUrl, formatId);
    // res.pipe(videoStream);
});
```

**For `/download/audio` endpoint (line ~469):**
```javascript
app.get('/download/audio', async (req, res) => {
    const url = req.query.url;
    const formatId = req.query.fmt;
    const cleanedUrl = cleanYouTubeUrl(url);
    
    // REPLACE THIS SECTION with your API call
    // Currently uses: spawn(ytdlpBin, ['-f', fmt, '-o', '-', ...])
});
```

### Step 3: Update Format Extraction

The format list is extracted in the `getYtdlpFormats()` function (line ~50). Replace it with your API:

```javascript
const getYtdlpFormats = async (url) => {
    // REPLACE THIS with your API
    // Should return array of format objects with structure:
    // {
    //   format_id: "96",
    //   height: 1080,
    //   ext: "mp4",
    //   filesize: 87876234,
    //   vcodec: "avc1.640028",
    //   acodec: "mp4a.40.2",
    //   abr: 128
    // }
};
```

### Step 4: Update Video Info Extraction

The `POST /download` endpoint extracts video info using yt-dlp. Replace the fallback section (line ~275):

```javascript
try {
    const proc = await youtubedl.exec(cleanedUrl, { j: true }, { stdio: 'pipe' });
    const infoJson = JSON.parse(proc.stdout);
    
    // REPLACE WITH YOUR API to get:
    // - title
    // - uploader
    // - duration
    // - thumbnail
    // - view_count
} catch (fbErr) {
    // Handle error
}
```

### Step 5: Example Implementation with YouTube Data API v3

If using YouTube Data API v3:

```javascript
const youtube = require('googleapis').youtube({
    version: 'v3',
    auth: 'YOUR_API_KEY'
});

const getYtdlpFormats = async (url) => {
    const videoId = extractVideoId(url);
    
    // Get video details
    const response = await youtube.videos.list({
        part: 'fileDetails',
        id: videoId
    });
    
    // Format the response to match expected structure
    return formatApiResponse(response.data);
};
```

### Step 6: Remove yt-dlp Dependency (Optional)

If you're completely replacing yt-dlp:

```bash
# Uninstall youtube-dl-exec
npm uninstall youtube-dl-exec

# Install your chosen package
npm install your-chosen-api-package
```

Then update the imports in `app.js`:
```javascript
// Remove: const youtubedl = require('youtube-dl-exec');
// Add: const yourAPI = require('your-chosen-api-package');
```

### Step 7: Update Environment Variables

Create a `.env` file for API credentials:

```env
YOUTUBE_API_KEY=your_api_key_here
YOUTUBE_API_SECRET=your_api_secret_here
```

Update `app.js` to load these:
```javascript
require('dotenv').config();
const apiKey = process.env.YOUTUBE_API_KEY;
```

## 📁 Project Structure

```
youtube-downloader/
├── app.js                    # Main Express server (main logic)
├── package.json              # Project dependencies
├── README.md                 # This file
├── views/
│   └── index.ejs            # Frontend HTML/EJS template
├── public/
│   ├── css/
│   │   └── style.css        # Additional styles
│   └── js/
│       └── main.js          # Frontend JavaScript
└── node_modules/            # Dependencies (created after npm install)
```

## 🔧 Key Files to Modify for Custom API

| File | Section | Purpose |
|------|---------|---------|
| `app.js` | `getYtdlpFormats()` | Extract available formats |
| `app.js` | `POST /download` | Extract video metadata |
| `app.js` | `GET /download/video` | Handle video streaming |
| `app.js` | `GET /download/audio` | Handle audio streaming |
| `views/index.ejs` | Download buttons | UI for video/audio selection |

## 🎯 API Integration Checklist

- [ ] Choose your YouTube data source/API
- [ ] Test API connectivity and authentication
- [ ] Implement `getYtdlpFormats()` replacement
- [ ] Implement video info extraction
- [ ] Implement video/audio streaming
- [ ] Test with sample YouTube URLs
- [ ] Update error handling
- [ ] Remove old yt-dlp references
- [ ] Update dependencies in package.json
- [ ] Test mobile responsiveness

## 📊 Available Formats

The application supports downloading in these video resolutions (when available):
- **1080p** (Full HD) - Format ID: 96
- **720p** (HD) - Format ID: 95
- **480p** - Format ID: 94
- **360p** - Format ID: 93
- **240p** - Format ID: 92
- **144p** - Format ID: 91

Audio quality options (bitrate):
- 320 kbps
- 256 kbps
- 192 kbps
- 128 kbps
- 96 kbps
- And more depending on source

## 🔒 Notes on Using APIs

### Official YouTube Data API v3
- **Pros:** Official, reliable, legal
- **Cons:** Rate limits, quota system, requires authentication
- **Cost:** Free tier available, paid tiers for higher usage
- **Docs:** https://developers.google.com/youtube/v3

### yt-dlp (Current Implementation)
- **Pros:** Comprehensive format support, no API key needed
- **Cons:** May break with YouTube updates, not officially supported
- **License:** Unlicense (public domain)
- **Docs:** https://github.com/yt-dlp/yt-dlp

### pytube
- **Pros:** Simple Python library, good for scripting
- **Cons:** Requires Node.js to Python bridge or rewrite
- **License:** MIT
- **Docs:** https://pytube.io/

## ⚠️ Legal Disclaimer

- Ensure you have the right to download content from YouTube
- Respect copyright and YouTube's Terms of Service
- Only download content you own or have permission to download
- This tool is for personal, non-commercial use

## 🐛 Troubleshooting

### Video/Audio won't download
- Check that the YouTube URL is valid
- Ensure you have internet connection
- Try a different video (some videos may be restricted)
- Check server logs: `tail -f /tmp/server.log`

### Formats not showing
- Server may still be extracting format list (takes 5-10 seconds)
- Try refreshing the page
- Check browser console for errors

### Server won't start
```bash
# Kill any existing process
pkill -f "node app.js"

# Try starting again
npm start
```

### Port already in use
```bash
# Kill process using port 3000
lsof -ti:3000 | xargs kill -9

# Or use different port
PORT=3001 npm start
```

## 📝 Logs

Server logs are saved to `/tmp/server.log`:
```bash
tail -f /tmp/server.log
```

## 🤝 Contributing

Feel free to fork and submit pull requests for any improvements.

## 📄 License

This project is provided as-is for educational purposes.

## 🙏 Credits

- **Created by:** Richky Sung
- **Backend:** Express.js, yt-dlp
- **Frontend:** EJS, Tailwind CSS, Font Awesome Icons
- **UI Inspiration:** Modern dark theme design

## 📧 Support

For issues or questions, please check:
1. This README
2. Server logs in `/tmp/server.log`
3. Browser console (F12)
4. GitHub Issues (if available)

---

**Happy Downloading! 🎬🎵**

Last Updated: December 15, 2025
