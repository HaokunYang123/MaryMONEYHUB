// The "Secretary" - Business logic for Trust but Verify workflow
// Supabase-only persistence (no local fallback)
// 
// WORKFLOW: Staging → Review → Production
// - Staging (Unprocessed): Raw files in "Unprocessed Files" folder
// - Review: Files in Supabase with status: 'needs_review'
// - Production: Approved files moved to "All Files/{path}" with status: 'processed'

import { analyzeAndCategorize, runTier1, runTier2, AIAnalysisResult, Tier1Result, Tier2Result } from '@/lib/invoice-extractor';
import { moveFileToFolder, FOLDERS } from '@/lib/google-drive';
import { supabase } from '@/lib/supabase';

// File interface for batch processing
interface BatchFile {
  driveId: string;
  buffer: Buffer;
  type: string;
}

/**
 * BATCH ORCHESTRATOR: Process documents in batches of 50
 * Uses tiered AI to minimize costs on 5,000+ files
 * 
 * Now includes suggestedPath and suggestedDestination for the "Smart Upload" workflow
 */
export async function processDocumentBatch(files: BatchFile[]) {
  console.log(`📦 Processing batch of ${files.length} files`);
  const results = [];
  const currentYear = new Date().getFullYear();

  for (const file of files) {
    try {
      // 1. Tier 1 runs on EVERYTHING ($0.00001 cost)
      const classification: Tier1Result = await runTier1(file.buffer, file.type);

      let finalData: Tier1Result & Partial<Tier2Result> = classification;
      let status = 'processed'; // Default for non-actionable

      // 2. Tier 2 (Gemini 2.5 Flash) runs ONLY on actionable items
      if (classification.needs_deep_analysis) {
        const deepData: Tier2Result = await runTier2(file.buffer, file.type);
        finalData = { ...classification, ...deepData };
        status = 'needs_review'; // Actionable items need Mary's approval
      } else {
        // For non-actionable items, set default suggestedPath and destination
        finalData = {
          ...classification,
          suggestedPath: `Documents/${currentYear}/${classification.subcategory || 'General'}`,
          suggestedDestination: 'Archive Only'
        };
      }

      // 3. Save to Supabase with the new prediction fields
      const { data: doc, error } = await supabase.from('documents').insert({
        drive_id: file.driveId,
        metadata: finalData,
        category: (finalData as Tier2Result).filingCategory || classification.subcategory || 'Uncategorized',
        status: status,
        is_duplicate: false,
      }).select().single();

      if (error) {
        console.error(`Failed to save ${file.driveId}:`, error.message);
      } else {
        results.push(doc);
      }

    } catch (error) {
      console.error(`Error processing ${file.driveId}:`, error);
    }
  }

  console.log(`✅ Batch complete: ${results.length}/${files.length} processed`);
  return results;
}

/**
 * PHASE 1: ANALYZE & HOLD (The "Smart Upload")
 * 
 * Analyzes the file with context-aware AI using Gemini Vision.
 * Creates a Prediction Object with:
 * - extracted_data: { vendorName, amount, date, description }
 * - suggested_path: e.g., "Invoices/2026/Verde Farms"
 * - suggested_destination: "QuickBooks" | "Archive Only"
 * 
 * Result: A record is created in Supabase with status: 'needs_review'
 */
export async function analyzeUploadedFile(
  fileId: string,
  fileBuffer: Buffer,
  mimeType: string,
  source: 'web' | 'drive' = 'web'
) {
  console.log(`🕵️‍♂️ Analyzing file: ${fileId} (Source: ${source}, Type: ${mimeType})`);
  const currentYear = new Date().getFullYear();

  // 1. Run AI Analysis with Gemini Vision (sends file directly)
  const analysis: AIAnalysisResult = await analyzeAndCategorize(fileBuffer, mimeType, source);

  // 2. Generate suggestedPath and suggestedDestination
  const vendorName = analysis.data.vendorName || 'Unknown';
  const amount = analysis.data.amount || 0;
  
  // Build the suggested path based on category and vendor
  const suggestedPath = analysis.isFinancial 
    ? `Invoices/${currentYear}/${vendorName.replace(/[\/\\]/g, '-')}`
    : `Documents/${currentYear}/${analysis.filingCategory}`;
  
  // Suggest QuickBooks if it's a financial document with an amount > 0
  const suggestedDestination = (analysis.isFinancial && amount > 0) 
    ? 'QuickBooks' 
    : 'Archive Only';

  // Enhance the analysis with prediction fields
  const enhancedAnalysis = {
    ...analysis,
    suggestedPath,
    suggestedDestination,
  };

  // 3. Handle Non-Financial Files (Drive source only)
  if (!analysis.isFinancial && source === 'drive') {
    console.log(`📂 Non-financial file detected: ${analysis.summary}`);

    // For non-financial files, still hold in review unless from drive
    const { data: doc, error } = await supabase
      .from('documents')
      .insert({
        drive_id: fileId,
        content: analysis.summary,
        metadata: enhancedAnalysis,
        category: analysis.filingCategory,
        status: 'needs_review', // Changed from 'archived' - let Mary decide
        is_duplicate: false,
        duplicate_of_id: null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    return {
      success: true,
      message: "Document ready for review",
      ...(doc ?? {}),
      suggestedPath,
      suggestedDestination,
      status: 'needs_review'
    };
  }

  // 4. Check for duplicates
  let isDuplicate = false;
  let duplicateId: string | null = null;

  try {
    const { data: duplicates, error } = await supabase
      .from('documents')
      .select('id')
      .filter('metadata->>vendorName', 'eq', analysis.data.vendorName)
      .filter('metadata->>amount', 'eq', String(analysis.data.amount))
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      throw new Error(error.message);
    }

    isDuplicate = duplicates && duplicates.length > 0;
    duplicateId = isDuplicate ? duplicates![0].id : null;
  } catch (error) {
    console.log('Duplicate check failed:', error);
  }

  // 5. Save Document with Prediction Object
  const { data: savedDoc, error: saveError } = await supabase
    .from('documents')
    .insert({
      drive_id: fileId,
      content: analysis.summary,
      metadata: enhancedAnalysis,
      category: analysis.filingCategory,
      status: 'needs_review',
      is_duplicate: isDuplicate,
      duplicate_of_id: duplicateId,
    })
    .select()
    .single();

  if (saveError) {
    throw new Error(`Supabase insert failed: ${saveError.message}`);
  }

  console.log(`✅ Document saved: ${savedDoc?.id}, isDuplicate: ${isDuplicate}`);
  console.log(`   Suggested Path: ${suggestedPath}`);
  console.log(`   Suggested Destination: ${suggestedDestination}`);
  
  return savedDoc;
}

/**
 * PHASE 2: EXECUTE (Legacy - simple confirm)
 * Triggered ONLY when Mary clicks "Confirm"
 * 
 * For the full workflow with QuickBooks integration,
 * use the /api/files/confirm endpoint instead.
 */
export async function confirmAndExecute(documentId: string) {
  console.log(`🚀 Confirming document: ${documentId}`);

  // Get document
  const { data: doc, error: fetchError } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .single();

  if (fetchError || !doc) {
    throw new Error(fetchError?.message || "Document not found");
  }

  if (doc.status === 'processed') {
    throw new Error("Document already processed");
  }

  const analysis = doc.metadata as AIAnalysisResult & { suggestedPath?: string };

  try {
    // Move file in Drive from Unprocessed to All Files
    try {
      // Use the AI-suggested path or fall back to category-based path
      const suggestedPath = analysis.suggestedPath || `Invoices/${analysis.filingCategory}`;
      const targetFolder = `${FOLDERS.ALL_FILES}/${suggestedPath}`;
      await moveFileToFolder(doc.drive_id, targetFolder);
      console.log(`📁 Moved file to ${targetFolder}`);
    } catch (driveError) {
      console.log('Drive move skipped:', driveError);
    }

    // Update status
    const { error: updateError } = await supabase
      .from('documents')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('id', documentId);

    if (updateError) {
      throw new Error(`Supabase update failed: ${updateError.message}`);
    }

    console.log(`✅ Document ${documentId} processed`);
    return { success: true, analysis };

  } catch (error) {
    console.error("Execution Failed:", error);
    throw error;
  }
}

/**
 * Reject a document
 * Moves the file to the "Rejected" folder and updates status
 */
export async function rejectDocument(documentId: string) {
  console.log(`❌ Rejecting document: ${documentId}`);
  
  // Get document for drive_id
  const { data: doc, error: fetchError } = await supabase
    .from('documents')
    .select('drive_id')
    .eq('id', documentId)
    .single();

  if (fetchError) {
    throw new Error(`Supabase fetch failed: ${fetchError.message}`);
  }

  // Move in Drive to the Rejected folder
  if (doc?.drive_id) {
    try {
      await moveFileToFolder(doc.drive_id, FOLDERS.REJECTED);
      console.log(`📂 Moved file to ${FOLDERS.REJECTED}`);
    } catch (driveError) {
      console.log('Drive move skipped:', driveError);
    }
  }

  // Update status
  const { error: updateError } = await supabase
    .from('documents')
    .update({ status: 'rejected', processed_at: new Date().toISOString() })
    .eq('id', documentId);

  if (updateError) {
    throw new Error(`Supabase update failed: ${updateError.message}`);
  }

  console.log(`✅ Document ${documentId} rejected`);
  return { success: true };
}

/**
 * Get all documents needing review
 */
export async function getPendingDocuments() {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('status', 'needs_review')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Supabase fetch failed: ${error.message}`);
  }

  return data || [];
}
