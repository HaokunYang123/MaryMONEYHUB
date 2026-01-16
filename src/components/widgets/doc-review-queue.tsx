"use client";

import { useMemo, useState } from "react";

// Destination options for the dropdown
const DESTINATION_OPTIONS = [
  { value: "QuickBooks", label: "QuickBooks", description: "Create bill & sync" },
  { value: "Archive Only", label: "Archive Only", description: "File only, no sync" },
] as const;

type DestinationType = typeof DESTINATION_OPTIONS[number]["value"];

type DocumentItem = {
  id: string;
  drive_file_id?: string;
  drive_id?: string;
  approval_status?: "PENDING" | "APPROVED" | "REJECTED" | "DUPLICATE";
  status?: string;
  doc_type?: string;
  extracted_data?: {
    vendorName?: string;
    vendor?: string;
    totalAmount?: number;
    amount?: number;
    invoiceDate?: string;
    date?: string;
    filingCategory?: string;
    description?: string;
  };
  metadata?: {
    filingCategory?: string;
    amount?: number;
    suggestedPath?: string;
    suggestedDestination?: DestinationType;
    data?: {
      vendorName?: string;
      amount?: number;
      date?: string;
      description?: string;
    };
  };
  previewUrl?: string;
};

const mockItems: DocumentItem[] = [
  {
    id: "doc-101",
    drive_file_id: "drive-101",
    approval_status: "PENDING",
    doc_type: "Invoice",
    extracted_data: { vendorName: "Arizona Packaging", totalAmount: 450, invoiceDate: "2026-01-10" },
    metadata: { 
      suggestedPath: "Invoices/2026/Arizona Packaging", 
      suggestedDestination: "QuickBooks" 
    },
    previewUrl: "",
  },
  {
    id: "doc-102",
    drive_file_id: "drive-102",
    approval_status: "PENDING",
    doc_type: "Receipt",
    extracted_data: { vendorName: "Home Depot", totalAmount: 312.45, invoiceDate: "2026-01-09" },
    metadata: { 
      suggestedPath: "Invoices/2026/Home Depot", 
      suggestedDestination: "QuickBooks" 
    },
    previewUrl: "",
  },
  {
    id: "doc-103",
    drive_file_id: "drive-103",
    approval_status: "DUPLICATE",
    doc_type: "Contract",
    extracted_data: { vendorName: "Mary's Real Estate LLC", totalAmount: 0 },
    metadata: { 
      suggestedPath: "Documents/2026/Legal Documents", 
      suggestedDestination: "Archive Only" 
    },
    previewUrl: "",
  },
];

function formatCurrency(value: number) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function getDocLabel(item: DocumentItem) {
  return item.doc_type || "Document";
}

function getVendor(item: DocumentItem) {
  return item.extracted_data?.vendorName || 
         item.extracted_data?.vendor || 
         item.metadata?.data?.vendorName ||
         "Unknown Vendor";
}

function getAmount(item: DocumentItem) {
  return item.extracted_data?.totalAmount || 
         item.extracted_data?.amount || 
         item.metadata?.data?.amount ||
         item.metadata?.amount || 
         0;
}

function getDate(item: DocumentItem) {
  return item.extracted_data?.invoiceDate || 
         item.extracted_data?.date || 
         item.metadata?.data?.date ||
         "Unknown Date";
}

function getDescription(item: DocumentItem) {
  return item.extracted_data?.description || 
         item.metadata?.data?.description ||
         "";
}

function getFilingCategory(item: DocumentItem) {
  return item.metadata?.filingCategory || 
         item.extracted_data?.filingCategory || 
         "Administrative";
}

function getSuggestedPath(item: DocumentItem) {
  return item.metadata?.suggestedPath || 
         `Invoices/${new Date().getFullYear()}/${getVendor(item)}`;
}

function getSuggestedDestination(item: DocumentItem): DestinationType {
  const suggested = item.metadata?.suggestedDestination;
  if (suggested === "QuickBooks" || suggested === "Archive Only") {
    return suggested;
  }
  // Default based on amount
  return getAmount(item) > 0 ? "QuickBooks" : "Archive Only";
}

function getDriveFileId(item: DocumentItem) {
  return item.drive_file_id || item.drive_id || "";
}

function getApprovalStatus(item: DocumentItem): DocumentItem["approval_status"] {
  // Map Supabase status to UI status
  if (item.approval_status) return item.approval_status;
  if (item.status === "needs_review") return "PENDING";
  if (item.status === "processed") return "APPROVED";
  if (item.status === "rejected") return "REJECTED";
  return "PENDING";
}

export default function DocReviewQueue({ items, apiBaseUrl = "" }: { items?: DocumentItem[], apiBaseUrl?: string }) {
  const [queue, setQueue] = useState<DocumentItem[]>(items || mockItems);
  const [activeItem, setActiveItem] = useState<DocumentItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ 
    vendorName: "", 
    totalAmount: "",
    targetPath: "",
    destination: "QuickBooks" as DestinationType
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  
  // Per-item destination selections (tracks user changes)
  const [destinations, setDestinations] = useState<Record<string, DestinationType>>({});

  const apiRoot = useMemo(() => apiBaseUrl.replace(/\/$/, ""), [apiBaseUrl]);

  const pending = queue.filter((item) => getApprovalStatus(item) === "PENDING");
  const duplicates = queue.filter((item) => getApprovalStatus(item) === "DUPLICATE");

  // Get the destination for an item (user-selected or AI-suggested)
  const getItemDestination = (item: DocumentItem): DestinationType => {
    return destinations[item.id] || getSuggestedDestination(item);
  };

  // Update destination for an item
  const setItemDestination = (itemId: string, destination: DestinationType) => {
    setDestinations(prev => ({ ...prev, [itemId]: destination }));
  };

  const startEdit = (item: DocumentItem) => {
    setActiveItem(item);
    setEditForm({
      vendorName: getVendor(item),
      totalAmount: String(getAmount(item)),
      targetPath: getSuggestedPath(item),
      destination: getItemDestination(item)
    });
    setEditing(true);
  };

  const updateItemStatus = (id: string, status: DocumentItem["approval_status"]) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, approval_status: status } : item))
    );
  };

  /**
   * APPROVE & SYNC: Calls the /api/files/confirm endpoint
   * This triggers the atomic commit: QB → Drive → Database
   */
  const handleApprove = async (item: DocumentItem) => {
    setLoadingId(item.id);
    
    const destination = getItemDestination(item);
    const targetPath = getSuggestedPath(item);
    const metadata = {
      vendorName: getVendor(item),
      amount: getAmount(item),
      date: getDate(item),
      description: getDescription(item),
      filingCategory: getFilingCategory(item),
    };

    try {
      const response = await fetch(`${apiRoot}/api/files/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId: item.id,
          driveFileId: getDriveFileId(item),
          destination,
          metadata,
          targetPath,
        }),
      });

      const result = await response.json();
      
      if (!response.ok) {
        console.error("[DocReviewQueue] Approval failed:", result.error);
        alert(`Error: ${result.error || "Approval failed"}`);
        return;
      }

      console.log("[DocReviewQueue] Approved successfully:", result);
      updateItemStatus(item.id, "APPROVED");
      
    } catch (error) {
      console.error("[DocReviewQueue] Approval error:", error);
      alert("Network error. Please try again.");
    } finally {
      setLoadingId(null);
    }
  };

  /**
   * REJECT: Calls the /api/files/reject endpoint
   */
  const handleReject = async (item: DocumentItem) => {
    setLoadingId(item.id);
    
    try {
      const response = await fetch(`${apiRoot}/api/files/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: item.id }),
      });

      const result = await response.json();
      
      if (!response.ok) {
        console.error("[DocReviewQueue] Rejection failed:", result.error);
        alert(`Error: ${result.error || "Rejection failed"}`);
        return;
      }

      updateItemStatus(item.id, "REJECTED");
      
    } catch (error) {
      console.error("[DocReviewQueue] Rejection error:", error);
      alert("Network error. Please try again.");
    } finally {
      setLoadingId(null);
    }
  };

  /**
   * RESOLVE DUPLICATE: Move back to pending for review
   */
  const handleResolveDuplicate = async (item: DocumentItem) => {
    setLoadingId(item.id);
    // For now, just move it back to pending locally
    // In a full implementation, this would call an API
    await new Promise(resolve => setTimeout(resolve, 300));
    updateItemStatus(item.id, "PENDING");
    setLoadingId(null);
  };

  const submitEdit = async () => {
    if (!activeItem) return;
    
    // Update the local state with edited values
    const updated: DocumentItem = {
      ...activeItem,
      extracted_data: {
        ...activeItem.extracted_data,
        vendorName: editForm.vendorName,
        totalAmount: Number(editForm.totalAmount) || 0,
      },
      metadata: {
        ...activeItem.metadata,
        suggestedPath: editForm.targetPath,
        suggestedDestination: editForm.destination,
      }
    };

    setQueue((prev) => prev.map((item) => (item.id === activeItem.id ? updated : item)));
    setDestinations(prev => ({ ...prev, [activeItem.id]: editForm.destination }));
    setEditing(false);
    setActiveItem(null);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-black text-slate-900">Document Review Queue</h3>
          <p className="text-xs text-slate-500">Review AI predictions and approve to sync</p>
        </div>
        <span className="px-2 py-1 text-xs font-bold rounded-full bg-[#1B5E20]/10 text-[#1B5E20]">
          {pending.length} PENDING
        </span>
      </div>

      <div className="space-y-4">
        {pending.map((item) => {
          const itemDestination = getItemDestination(item);
          const amount = getAmount(item);
          
          return (
            <div
              key={item.id}
              className="grid grid-cols-1 md:grid-cols-[120px_1fr_240px] gap-4 border border-slate-200 rounded-lg p-4 bg-slate-50"
            >
              {/* PREVIEW THUMBNAIL */}
              <div className="flex items-center justify-center bg-white border border-slate-200 rounded-lg h-28">
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="Document preview" className="h-full w-full object-cover rounded-lg" />
                ) : (
                  <span className="material-symbols-outlined text-slate-400 text-4xl">picture_as_pdf</span>
                )}
              </div>
              
              {/* DOCUMENT INFO + AI PREDICTION */}
              <div
                className="cursor-pointer group"
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <p className="text-xs uppercase text-slate-400 font-bold">{getDocLabel(item)}</p>

                {/* VENDOR NAME (expandable) */}
                <p className={`text-lg font-semibold text-slate-800 leading-tight transition-all ${
                  expandedId === item.id ? "whitespace-normal" : "truncate max-w-[280px]"
                }`}>
                  {getVendor(item)}
                </p>

                {/* AI PREDICTION DISPLAY */}
                <div className="flex flex-col mt-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#1B5E20] text-sm">folder</span>
                    <p className="text-xs font-medium text-slate-600">
                      {getSuggestedPath(item)}
                    </p>
                  </div>
                  
                  {/* What happens when approved */}
                  <p className="text-[10px] text-[#1B5E20] font-medium italic">
                    {itemDestination === "QuickBooks" && amount > 0
                      ? "→ Will create bill in QuickBooks & move to folder"
                      : "→ Will move to folder only (no sync)"}
                  </p>
                </div>

                <div className="flex items-center gap-4 mt-2">
                  <p className="text-sm text-slate-500">{getDate(item)}</p>
                  <p className="text-base font-bold text-[#1B5E20]">
                    {amount > 0 ? formatCurrency(amount) : "Non-Financial / $0.00"}
                  </p>
                </div>
              </div>
              
              {/* ACTIONS + DESTINATION DROPDOWN */}
              <div className="flex flex-col gap-2">
                {/* DESTINATION DROPDOWN */}
                <div className="mb-1">
                  <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                    Destination
                  </label>
                  <select
                    value={itemDestination}
                    onChange={(e) => setItemDestination(item.id, e.target.value as DestinationType)}
                    className="w-full px-2 py-1.5 text-xs font-medium border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-[#1B5E20]/20 focus:border-[#1B5E20]"
                  >
                    {DESTINATION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                
                {/* ACTION BUTTONS */}
                <button
                  onClick={() => handleApprove(item)}
                  disabled={loadingId === item.id}
                  className="px-3 py-2 rounded-lg bg-[#1B5E20] text-white text-xs font-bold hover:bg-[#1B5E20]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                >
                  {loadingId === item.id ? (
                    <>
                      <span className="animate-spin">⏳</span>
                      Processing...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      Approve & Sync
                    </>
                  )}
                </button>
                <button
                  onClick={() => startEdit(item)}
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 bg-white hover:bg-slate-50 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">edit</span>
                  Edit
                </button>
                <button
                  onClick={() => handleReject(item)}
                  disabled={loadingId === item.id}
                  className="px-3 py-2 rounded-lg border border-[#D32F2F]/40 text-xs font-bold text-[#D32F2F] bg-white hover:bg-[#D32F2F]/5 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">cancel</span>
                  Reject
                </button>
              </div>
            </div>
          );
        })}

        {pending.length === 0 && (
          <div className="text-center text-sm text-slate-500 py-8 flex flex-col items-center gap-2">
            <span className="material-symbols-outlined text-3xl text-slate-300">inbox</span>
            No pending approvals. Inbox is clean.
          </div>
        )}
      </div>

      {/* DUPLICATE ALERTS */}
      {duplicates.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center gap-2 text-[#D32F2F] font-bold text-sm mb-3">
            <span className="material-symbols-outlined">warning</span>
            Duplicate Alerts
          </div>
          <div className="space-y-3">
            {duplicates.map((item) => (
              <div key={item.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border border-[#D32F2F]/30 rounded-lg p-4 bg-[#D32F2F]/5">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{getVendor(item)}</p>
                  <p className="text-xs text-slate-500">{getDocLabel(item)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleResolveDuplicate(item)}
                    disabled={loadingId === item.id}
                    className="px-3 py-1.5 rounded-lg bg-[#1B5E20] text-white text-xs font-bold hover:bg-[#1B5E20]/90 transition-colors"
                  >
                    Keep Both
                  </button>
                  <button
                    onClick={() => handleReject(item)}
                    disabled={loadingId === item.id}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 bg-white hover:bg-slate-50 transition-colors"
                  >
                    Delete New
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editing && activeItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
              <h4 className="font-bold text-slate-900">Edit Extracted Data</h4>
              <button
                onClick={() => setEditing(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs font-bold uppercase text-slate-400">Vendor</label>
                <input
                  value={editForm.vendorName}
                  onChange={(event) => setEditForm((prev) => ({ ...prev, vendorName: event.target.value }))}
                  className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-400">Amount</label>
                <input
                  type="number"
                  value={editForm.totalAmount}
                  onChange={(event) => setEditForm((prev) => ({ ...prev, totalAmount: event.target.value }))}
                  className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-400">File Path</label>
                <input
                  value={editForm.targetPath}
                  onChange={(event) => setEditForm((prev) => ({ ...prev, targetPath: event.target.value }))}
                  placeholder="e.g., Invoices/2026/Verde Farms"
                  className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-400">Destination</label>
                <select
                  value={editForm.destination}
                  onChange={(event) => setEditForm((prev) => ({ ...prev, destination: event.target.value as DestinationType }))}
                  className="mt-2 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                >
                  {DESTINATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} - {opt.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={() => setEditing(false)}
                  className="px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-800"
                >
                  Cancel
                </button>
                <button
                  onClick={submitEdit}
                  className="px-4 py-2 bg-[#1B5E20] text-white rounded-lg text-sm font-bold hover:bg-[#1B5E20]/90 transition-colors"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
