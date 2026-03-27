import { createHash } from "node:crypto"
import path from "node:path"
import { CloudinaryAsset } from "../types/migration"
import { attachRetryAfter } from "./retry"

export async function downloadImage(url: string): Promise<Buffer> {
	const response = await fetch(url)
	if (!response.ok) {
		const error = new Error(
			`Image download failed with status ${response.status}.`,
		) as any
		error.status = response.status
		attachRetryAfter(error, response.headers.get("retry-after"))
		throw error
	}

	const arrayBuffer = await response.arrayBuffer()
	return Buffer.from(arrayBuffer)
}

export function isInScopePng(resource: any): boolean {
	if (!resource) {
		return false
	}

	if (!isPngImageResource(resource)) {
		return false
	}

	const publicId = String(resource.public_id ?? "")
	const baseName = path.basename(publicId)
	return baseName.startsWith("Picture_of")
}

export function isPngImageResource(resource: any): boolean {
	if (!resource) {
		return false
	}

	const format = String(resource.format ?? "").toLowerCase()
	const resourceType = String(resource.resource_type ?? "").toLowerCase()
	return resourceType === "image" && format === "png"
}

export function toAsset(resource: any): CloudinaryAsset {
	return {
		publicId: String(resource.public_id),
		secureUrl: String(resource.secure_url),
		bytes: Number(resource.bytes ?? 0),
		format: String(resource.format ?? ""),
		resourceType: String(resource.resource_type ?? ""),
	}
}

export function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}
