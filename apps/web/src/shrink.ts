/**
 * Shrinks a phone photo before upload: longest side 1600px, JPEG quality 0.85. A 4 MB camera
 * photo becomes ~300 KB, which matters on pay-per-MB mobile data. Re-encoding also drops EXIF
 * data such as GPS location. PDFs, and anything the browser cannot decode, go as they are.
 */
export async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  if (!/^image\/(jpeg|png)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}
