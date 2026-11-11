const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
// Dynamic port for cloud hosting (Render, Railway, Heroku) or local 3000
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Detect operating system & locate binaries
const isWindows = process.platform === 'win32';
const BIN_DIR = path.join(__dirname, 'bin');
const localWindowsYtDlp = path.join(BIN_DIR, 'yt-dlp.exe');

// If on Windows and local binary exists, use it. Otherwise use system command (Linux/Docker)
const YTDLP_CMD = (isWindows && fs.existsSync(localWindowsYtDlp)) ? localWindowsYtDlp : 'yt-dlp';
const FFMPEG_LOCATION = (isWindows && fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))) ? BIN_DIR : null;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// In-memory task tracking
const tasks = new Map();

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Live / Unknown';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Build common arguments for yt-dlp
function getCommonArgs() {
  const args = ['--no-playlist', '--no-warnings'];
  if (FFMPEG_LOCATION) {
    args.push('--ffmpeg-location', FFMPEG_LOCATION);
  }
  return args;
}

// 1. Fetch Video Info
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const cleanUrl = url.trim();
  const args = [
    '--dump-single-json',
    ...getCommonArgs(),
    cleanUrl
  ];

  const child = spawn(YTDLP_CMD, args, { windowsHide: true });
  let stdoutData = '';
  let stderrData = '';

  child.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  child.stderr.on('data', (data) => {
    stderrData += data.toString();
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp error:', stderrData);
      return res.status(500).json({
        error: 'Video info fetch nahi ho saki. Link verify karein ya dobara koshish karein.',
        details: stderrData.slice(0, 300)
      });
    }

    try {
      const info = JSON.parse(stdoutData);
      
      const formats = info.formats || [];
      const has1080p = formats.some(f => f.height && f.height >= 1080);
      const has720p = formats.some(f => f.height && f.height >= 720);
      const has480p = formats.some(f => f.height && f.height >= 480);

      const availableQualities = [
        { id: 'best', label: 'Best Quality (Auto MP4)', desc: 'Highest resolution available' }
      ];

      if (has1080p) availableQualities.push({ id: '1080p', label: '1080p Full HD', desc: '1920x1080 MP4' });
      if (has720p) availableQualities.push({ id: '720p', label: '720p HD', desc: '1280x720 MP4' });
      if (has480p) availableQualities.push({ id: '480p', label: '480p Standard', desc: '854x480 MP4' });
      
      availableQualities.push({ id: 'mp3', label: 'Audio Only (MP3)', desc: 'High Quality 320kbps MP3' });

      res.json({
        title: info.title || 'Untitled Video',
        thumbnail: info.thumbnail || '',
        duration: formatDuration(info.duration),
        uploader: info.uploader || info.channel || info.creator || 'Unknown',
        platform: info.extractor_key || info.extractor || 'Web Video',
        url: cleanUrl,
        qualities: availableQualities
      });
    } catch (err) {
      console.error('JSON parse error:', err);
      res.status(500).json({ error: 'Server could not parse video metadata.' });
    }
  });
});

// 2. Start Download
app.post('/api/download', (req, res) => {
  const { url, quality } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const taskId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const outTemplate = path.join(DOWNLOADS_DIR, '%(title).80s_%(id)s.%(ext)s');

  let formatArgs = [];
  if (quality === 'mp3') {
    formatArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  } else if (quality === '1080p') {
    formatArgs = ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/best', '--merge-output-format', 'mp4'];
  } else if (quality === '720p') {
    formatArgs = ['-f', 'bv*[height<=720]+ba/b[height<=720]/best', '--merge-output-format', 'mp4'];
  } else if (quality === '480p') {
    formatArgs = ['-f', 'bv*[height<=480]+ba/b[height<=480]/best', '--merge-output-format', 'mp4'];
  } else {
    formatArgs = ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'];
  }

  const args = [
    ...formatArgs,
    ...getCommonArgs(),
    '--newline',
    '--print', 'after_move:filepath',
    '-o', outTemplate,
    url
  ];

  const taskData = {
    id: taskId,
    status: 'starting',
    progress: 0,
    speed: '',
    eta: '',
    filePath: null,
    fileName: null,
    error: null
  };
  tasks.set(taskId, taskData);

  const child = spawn(YTDLP_CMD, args, { windowsHide: true });
  let finalPath = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (fs.existsSync(trimmed)) {
        finalPath = trimmed;
        taskData.filePath = trimmed;
        taskData.fileName = path.basename(trimmed);
        continue;
      }

      const downloadMatch = trimmed.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/i);
      if (downloadMatch) {
        taskData.status = 'downloading';
        taskData.progress = parseFloat(downloadMatch[1]);
        taskData.speed = downloadMatch[3];
        taskData.eta = downloadMatch[4];
        continue;
      }

      const percentMatch = trimmed.match(/\[download\]\s+([\d\.]+)%/i);
      if (percentMatch) {
        taskData.status = 'downloading';
        taskData.progress = parseFloat(percentMatch[1]);
      }

      if (trimmed.includes('[Merger]') || trimmed.includes('[ExtractAudio]') || trimmed.includes('[Fixup')) {
        taskData.status = 'processing';
        taskData.progress = 98;
        taskData.speed = 'Finalizing...';
        taskData.eta = '';
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.error(`[task-${taskId}] stderr:`, text);
  });

  child.on('close', (code) => {
    if (code === 0) {
      taskData.status = 'completed';
      taskData.progress = 100;
      if (!taskData.filePath && finalPath) {
        taskData.filePath = finalPath;
        taskData.fileName = path.basename(finalPath);
      } else if (!taskData.filePath) {
        const files = fs.readdirSync(DOWNLOADS_DIR)
          .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtime.getTime() }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 0) {
          taskData.filePath = path.join(DOWNLOADS_DIR, files[0].name);
          taskData.fileName = files[0].name;
        }
      }
    } else {
      taskData.status = 'error';
      taskData.error = 'Download fail ho gaya. Kripya link verify karein.';
    }
  });

  res.json({ taskId });
});

// 3. Check Progress
app.get('/api/progress/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// 4. Download file directly to browser
app.get('/api/file/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task || !task.filePath || !fs.existsSync(task.filePath)) {
    return res.status(404).json({ error: 'File not ready or not found' });
  }

  res.download(task.filePath, task.fileName || 'video.mp4');
});

// 5. Open downloads folder (Windows/Linux)
app.post('/api/open-folder', (req, res) => {
  if (isWindows) {
    exec(`explorer "${DOWNLOADS_DIR}"`, (err) => {
      if (err) return res.status(500).json({ error: 'Could not open folder' });
      res.json({ success: true, path: DOWNLOADS_DIR });
    });
  } else {
    res.json({ success: true, message: 'Running on cloud server, files are delivered directly to your browser!' });
  }
});

// 6. Get list of files in downloads
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .map(file => {
        const filePath = path.join(DOWNLOADS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: (stats.size / (1024 * 1024)).toFixed(1) + ' MB',
          date: stats.mtime
        };
      })
      .sort((a, b) => b.date - a.date)
      .slice(0, 10);

    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read history' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 Universal Video Downloader is running!`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📁 Downloads saved to: ${DOWNLOADS_DIR}`);
  console.log(`===============================================`);
});
