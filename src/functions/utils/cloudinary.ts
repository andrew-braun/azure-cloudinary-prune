import { v2 as cloudinary } from "cloudinary"
import { requireSetting } from "./config"

export function configureCloudinary(): void {
	const cloudName = requireSetting("CLOUDINARY_CLOUD_NAME")
	const apiKey = requireSetting("CLOUDINARY_API_KEY")
	const apiSecret = requireSetting("CLOUDINARY_API_SECRET")

	cloudinary.config({
		cloud_name: cloudName,
		api_key: apiKey,
		api_secret: apiSecret,
		secure: true,
	})
}

export function getCloudinaryClient() {
	configureCloudinary()
	return cloudinary
}

export async function overwriteCloudinaryImage(
	publicId: string,
	data: Buffer,
): Promise<void> {
	const client = getCloudinaryClient()

	await new Promise<void>((resolve, reject) => {
		const stream = client.uploader.upload_stream(
			{
				public_id: publicId,
				overwrite: true,
				invalidate: true,
				format: "png",
				resource_type: "image",
			},
			(error) => {
				if (error) {
					reject(error)
					return
				}

				resolve()
			},
		)

		stream.end(data)
	})
}
