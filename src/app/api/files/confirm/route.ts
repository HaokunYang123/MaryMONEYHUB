import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { moveFileToFolder, FOLDERS } from '@/lib/google-drive';
import { createBill } from '@/lib/quickbooks';

/**
 * CONFIRM ENDPOINT: The Atomic Commit
 * 
 * This is the "execution" step in the Staging → Review → Production pipeline.
 * When Mary clicks "Confirm", we:
 * 1. Execute Integration (QuickBooks bill creation if applicable)
 * 2. Move file in Google Drive (from Unprocessed → All Files/{path})
 * 3. Update database state (status → processed)
 * 
 * This is an atomic operation - if QB fails, the file stays in review.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      docId,           // Supabase document ID
      driveFileId,     // Google Drive file ID
      destination,     // "QuickBooks" | "Archive Only"
      metadata,        // { vendorName, amount, date, description }
      targetPath       // e.g., "Invoices/2026/Verde Farms"
    } = body;

    // Validate required fields
    if (!docId) {
      return NextResponse.json({ error: 'Document ID required' }, { status: 400 });
    }

    console.log(`🚀 Confirming document: ${docId}`);
    console.log(`   Destination: ${destination}`);
    console.log(`   Target Path: ${targetPath}`);

    // Fetch document from Supabase if we need the drive_id
    let fileId = driveFileId;
    if (!fileId) {
      const { data: doc, error: fetchError } = await supabase
        .from('documents')
        .select('drive_id, metadata')
        .eq('id', docId)
        .single();

      if (fetchError || !doc) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }
      fileId = doc.drive_id;
    }

    // ============================================================
    // STEP 1: EXECUTE INTEGRATION (QuickBooks)
    // ============================================================
    let integrationResult = null;
    let qbBillId = null;

    if (destination === 'QuickBooks' && metadata?.amount > 0) {
      console.log(`📊 Creating QuickBooks bill for ${metadata.vendorName}...`);
      
      try {
        const bill = await createBill({
          vendorName: metadata.vendorName || 'Unknown Vendor',
          dueDate: metadata.date || new Date().toISOString().split('T')[0],
          lineItems: [{
            description: metadata.description || `Invoice from ${metadata.vendorName}`,
            amount: metadata.amount || 0,
            category: metadata.filingCategory || 'Miscellaneous'
          }],
          invoiceNumber: metadata.invoiceNumber
        });

        qbBillId = bill?.Id;
        integrationResult = { 
          success: true, 
          billId: qbBillId,
          message: `Bill created in QuickBooks (ID: ${qbBillId})`
        };
        console.log(`✅ QuickBooks bill created: ${qbBillId}`);
      } catch (qbError) {
        // If QB fails, we stop here and alert the user
        // The file stays in "Review" status so Mary knows it didn't happen
        console.error('❌ QuickBooks Error:', qbError);
        return NextResponse.json({ 
          error: 'QuickBooks bill creation failed. Document remains in review.',
          details: qbError instanceof Error ? qbError.message : 'Unknown error'
        }, { status: 500 });
      }
    } else if (destination === 'Archive Only') {
      integrationResult = { 
        success: true, 
        message: 'Archived without QuickBooks sync' 
      };
      console.log(`📁 Archiving without QuickBooks sync`);
    }

    // ============================================================
    // STEP 2: ORGANIZE IN GOOGLE DRIVE
    // Move from "Unprocessed" to "All Files/{targetPath}"
    // ============================================================
    let finalDrivePath = '';
    
    try {
      // Build the final path: "All Files/Invoices/2026/Verde Farms"
      const cleanPath = targetPath?.replace(/^\/+/, '') || 'Uncategorized';
      finalDrivePath = `${FOLDERS.ALL_FILES}/${cleanPath}`;
      
      console.log(`📂 Moving file to: ${finalDrivePath}`);
      await moveFileToFolder(fileId, finalDrivePath);
      console.log(`✅ File moved successfully`);
    } catch (driveError) {
      // Log but don't fail - Drive organization is nice-to-have
      console.error('⚠️ Drive move failed (continuing):', driveError);
    }

    // ============================================================
    // STEP 3: UPDATE DATABASE STATE
    // ============================================================
    const updatePayload = {
      status: 'processed' as const,
      processed_at: new Date().toISOString(),
      category: targetPath || 'Uncategorized',
      metadata: {
        ...metadata,
        destination,
        qbBillId,
        finalDrivePath,
        processed_at: new Date().toISOString()
      }
    };

    const { error: updateError } = await supabase
      .from('documents')
      .update(updatePayload)
      .eq('id', docId);

    if (updateError) {
      console.error('❌ Database update failed:', updateError);
      return NextResponse.json({ 
        error: 'Database update failed',
        details: updateError.message
      }, { status: 500 });
    }

    console.log(`✅ Document ${docId} processed successfully`);

    return NextResponse.json({ 
      success: true, 
      message: 'Document processed successfully',
      integration: integrationResult,
      drivePath: finalDrivePath,
      docId
    });

  } catch (error) {
    console.error('❌ Confirmation Error:', error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'Confirmation failed' 
    }, { status: 500 });
  }
}
