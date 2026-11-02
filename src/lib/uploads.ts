import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import { env, uploadsEnabled } from "../env";

if (uploadsEnabled) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/** Uploads a receipt as an *authenticated* asset: it can only be opened through a signed URL. */
export function uploadReceipt(messId: string, buffer: Buffer): Promise<string> {
  const publicId = `meal-system/${messId}/${crypto.randomBytes(12).toString("hex")}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        type: "authenticated",
        resource_type: "image",
        overwrite: false,
        transformation: [{ width: 1600, height: 1600, crop: "limit", quality: "auto", fetch_format: "jpg" }],
      },
      (err, result) => (err || !result ? reject(err || new Error("Upload failed")) : resolve(result.public_id)),
    );
    stream.end(buffer);
  });
}

export function receiptUrl(receiptId: string): string | null {
  if (!uploadsEnabled) return null;
  return cloudinary.url(receiptId, { type: "authenticated", sign_url: true, secure: true, resource_type: "image", format: "jpg" });
}
