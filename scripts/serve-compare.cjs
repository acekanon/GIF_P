const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const port = 5173;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendFile(req, res, file) {
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const range = req.headers.range;
    const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (range) {
      const [startText, endText] = range.replace(/bytes=/, "").split("-");
      const start = Number(startText);
      const end = endText ? Number(endText) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const clean = decoded.replace(/^\/+/, "").replace(/\//g, path.sep);
  const full = path.resolve(base, clean);
  return full.startsWith(base) ? full : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  let file;

  if (url.pathname === "/" || url.pathname === "/index.html") {
    file = path.join(dist, "index.html");
  } else if (url.pathname.startsWith("/assets/")) {
    file = safeJoin(dist, url.pathname);
  } else {
    file = safeJoin(root, url.pathname);
  }

  if (!file) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(req, res, file);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Compare server: http://127.0.0.1:${port}/`);
});
