import { NextRequest, NextResponse } from 'next/server';
import { analyzeUploadedFile } from '@/lib/ai/secretary';
import { uploadFileToDrive, FOLDERS } from '@/lib/google-drive';

/**
 * UPLOAD ENDPOINT: The "Smart" Upload (Ingest)
 * 
 * Step 1 of the Staging → Review → Production pipeline.
 * 
 * Action: User uploads a PDF
 * System:
 * 1. Uploads file to Google Drive folder "Unprocessed Files" (Staging)
 * 2. Gemini scans the text
 * 3. Gemini generates a Prediction Object with:
 *    - extracted_data: { vendorName, amount, date, description }
 *    - suggested_path: e.g., "Invoices/2026/Verde Farms"
 *    - suggested_destination: "QuickBooks" | "Archive Only"
 * 
 * Result: A record is created in Supabase with status: 'needs_review'
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    console.log(`📥 Receiving file: ${file.name} (${file.type})`);

    // 1. Upload to Google Drive "Unprocessed Files" folder (STAGING)
    const driveId = await uploadFileToDrive(file, FOLDERS.UNPROCESSED);

    if (!driveId) {
      throw new Error("Drive upload failed");
    }

    console.log(`✅ Uploaded to ${FOLDERS.UNPROCESSED} (ID: ${driveId})`);

    // 2. Get file buffer for Gemini Vision analysis
    const buffer = Buffer.from(await file.arrayBuffer());

    // 3. Trigger AI Analysis with Gemini Vision
    // Creates a Prediction Object and saves to Supabase with status: 'needs_review'
    const result = await analyzeUploadedFile(driveId, buffer, file.type, 'web');

    return NextResponse.json(result);

  } catch (error) {
    console.error("API Error:", error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
