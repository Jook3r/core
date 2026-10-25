/**
 * Image attachments for the DeepSeek panel: reads image files (paste, drop,
 * file picker) and downscales large ones in the browser so that messages stay
 * small. The API recommends at most ~1568px on the long edge.
 */
define(function(require, exports, module) {
    "use strict";

    var MAX_EDGE = 1568;
    var MAX_BYTES = 1.5 * 1024 * 1024;     // re-encode anything bigger than this
    var MAX_INPUT_BYTES = 40 * 1024 * 1024; // refuse to even decode bigger files
    var JPEG_QUALITY = 0.85;
    var TYPES = /^image\/(png|jpeg|gif|webp)$/;

    function readAsDataUrl(blob, callback) {
        var reader = new FileReader();
        reader.onload = function() { callback(null, reader.result); };
        reader.onerror = function() { callback(new Error("Could not read the image")); };
        reader.readAsDataURL(blob);
    }

    function splitDataUrl(url) {
        var m = /^data:([^;,]+);base64,(.*)$/.exec(url || "");
        return m ? { mediaType: m[1], data: m[2] } : null;
    }

    /**
     * Prepares an image File/Blob for sending.
     * callback(err, { mediaType, data (base64), width, height, name, size, resized })
     */
    function prepare(file, callback) {
        var type = String(file && file.type || "").toLowerCase();
        if (type == "image/jpg") type = "image/jpeg";
        if (!TYPES.test(type))
            return callback(new Error("Unsupported image type" + (type ? ": " + type : "") + ". Use PNG, JPEG, GIF or WebP."));
        if (file.size > MAX_INPUT_BYTES)
            return callback(new Error("The image is too large (" + Math.round(file.size / 1048576) + " MB)."));

        readAsDataUrl(file, function(err, url) {
            if (err) return callback(err);
            var img = new Image();
            img.onload = function() {
                var w = img.naturalWidth, h = img.naturalHeight;
                var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
                var name = file.name || "image";
                if (scale == 1 && file.size <= MAX_BYTES) {
                    var parts = splitDataUrl(url);
                    if (!parts) return callback(new Error("Could not read the image"));
                    return callback(null, { mediaType: type, data: parts.data, width: w, height: h,
                        name: name, size: file.size, resized: false });
                }
                var cw = Math.max(1, Math.round(w * scale));
                var ch = Math.max(1, Math.round(h * scale));
                var canvas = document.createElement("canvas");
                canvas.width = cw;
                canvas.height = ch;
                var ctx = canvas.getContext("2d");
                ctx.imageSmoothingQuality = "high";

                var out = null;
                if (type == "image/png") {
                    ctx.drawImage(img, 0, 0, cw, ch);
                    out = canvas.toDataURL("image/png");
                    if (out.length * 0.75 > MAX_BYTES)
                        out = null; // a photo saved as PNG: JPEG below
                }
                if (!out) {
                    // JPEG has no alpha: paint transparent areas white
                    ctx.clearRect(0, 0, cw, ch);
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, cw, ch);
                    ctx.drawImage(img, 0, 0, cw, ch);
                    out = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
                }
                var result = splitDataUrl(out);
                if (!result) return callback(new Error("Could not convert the image"));
                callback(null, { mediaType: result.mediaType, data: result.data, width: cw, height: ch,
                    name: name, size: Math.round(result.data.length * 0.75), resized: true });
            };
            img.onerror = function() {
                callback(new Error("Could not decode the image"));
            };
            img.src = url;
        });
    }

    /**
     * Image files from a DataTransfer (paste or drop).
     */
    function filesFrom(dataTransfer) {
        var files = [];
        if (!dataTransfer) return files;
        var items = dataTransfer.items;
        if (items && items.length) {
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind == "file" && /^image\//i.test(items[i].type)) {
                    var f = items[i].getAsFile();
                    if (f) files.push(f);
                }
            }
        }
        if (!files.length && dataTransfer.files) {
            for (var j = 0; j < dataTransfer.files.length; j++) {
                if (/^image\//i.test(dataTransfer.files[j].type))
                    files.push(dataTransfer.files[j]);
            }
        }
        return files;
    }

    function hasFiles(dataTransfer) {
        var types = dataTransfer && dataTransfer.types;
        if (!types) return false;
        for (var i = 0; i < types.length; i++) {
            if (types[i] == "Files") return true;
        }
        return false;
    }

    module.exports = {
        prepare: prepare,
        filesFrom: filesFrom,
        hasFiles: hasFiles,
        MAX_EDGE: MAX_EDGE
    };
});
