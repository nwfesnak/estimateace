'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { createClient } from '@supabase/supabase-js';

export default function Home() {
  const supabase = useMemo(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }, []);

  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView' | 'archivesView' | 'sendPreview' | 'reportsView'>('dashboard');

  // ... (all your state variables are unchanged - I kept them exactly as before) ...

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');

  const [isReceiptExtractModalOpen, setIsReceiptExtractModalOpen] = useState(false);
  const [currentReceiptUrl, setCurrentReceiptUrl] = useState('');
  const [tempReceiptData, setTempReceiptData] = useState({ date: '', vendor: '', amount: 0, notes: '' });

  const [exportOptions, setExportOptions] = useState({
    estimates: true,
    invoices: true,
    archives: true,
    photos: true,
    videos: true
  });

  const [selectedReportJob, setSelectedReportJob] = useState<any>(null);

  const showMessage = (message: string) => {
    const clean = message.replace(/^[^\s]*\.vercel\.app says:\s*/i, '').trim();
    alert(clean);
  };

  // ... (all your functions up to saveToDB remain the same) ...

  const saveToDB = async () => {
    if (!user || !supabase) return;
    const data = {
      user_id: user.id,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile, documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod, photoUrls, videoUrls, receiptUrls, receiptDetails,
      laborHours, laborRate, laborFixedAmount, useHourlyLabor,   // ← laborAmount removed (it doesn't exist in your table)
      taxRate, taxAmount,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) console.error('Save error:', error);
    else setLastSaved(new Date().toLocaleTimeString());
  };

  // ... (rest of your functions are unchanged) ...

  // Dashboard calculations (already working for you)
  const estimatesList = useMemo(() => {
    return savedEstimatesList.filter(est => 
      est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST')
    );
  }, [savedEstimatesList]);

  const invoicesList = useMemo(() => {
    return savedEstimatesList.filter(est => 
      est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')
    );
  }, [savedEstimatesList]);

  const getGrandTotal = useCallback((doc: any): number => {
    if (!doc) return 0;
    const itemsTotal = (doc.items || []).reduce((sum: number, item: any) => sum + (parseFloat(item?.total) || 0), 0);
    const labor = parseFloat(doc.laborAmount) || (doc.useHourlyLabor ? (doc.laborHours || 0) * (doc.laborRate || 0) : (doc.laborFixedAmount || 0));
    const tax = parseFloat(doc.taxAmount) || 0;
    return itemsTotal + labor + tax;
  }, []);

  const totalEstJobs = estimatesList.length;
  const totalEstAmount = useMemo(() => 
    estimatesList.reduce((sum, est) => sum + getGrandTotal(est), 0), 
    [estimatesList, getGrandTotal]
  );

  const totalInvJobs = invoicesList.length;
  const totalInvOwed = useMemo(() => 
    invoicesList.reduce((sum, inv) => {
      if (inv.paymentStatus === 'paid') return sum;
      const grand = getGrandTotal(inv);
      const paidAmt = parseFloat(inv.amountPaid) || 0;
      return sum + Math.max(grand - paidAmt, 0);
    }, 0), 
    [invoicesList, getGrandTotal]
  );

  // ... (login, signup, handleMediaUpload, etc. unchanged) ...

  if (!user) {
    // ... login screen unchanged ...
  }

  return (
    <>
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          #print-document, #print-document * { visibility: visible; }
          #print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 40px; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="flex flex-col h-screen bg-[#f4f4f4]">
        <div className="flex-1 overflow-auto p-4 md:p-8">
          {view === 'dashboard' && (
            <div>
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-4xl font-semibold text-[#1e293b]">Welcome back!</h2>
                  <p className="text-gray-600 mt-1">Here’s what’s happening with your business</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm text-gray-500">Total Documents</p>
                    <p className="text-4xl font-bold text-[#1e293b]">{savedEstimatesList.length}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm text-gray-500">Estimates</p>
                    <p className="text-4xl font-bold text-[#1e293b]">{totalEstJobs}</p>
                    <p className="text-sm text-gray-500 mt-4">Total Value</p>
                    <p className="text-4xl font-bold text-[#10b981]">${totalEstAmount.toFixed(0)}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm text-gray-500">Invoices</p>
                    <p className="text-4xl font-bold text-[#1e293b]">{totalInvJobs}</p>
                    <p className="text-sm text-gray-500 mt-4">Total Owed</p>
                    <p className="text-4xl font-bold text-amber-600">${totalInvOwed.toFixed(0)}</p>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-4">Recently Viewed Documents</h3>
                    <div className="space-y-3">
                      {savedEstimatesList.slice(0, 5).map((est) => (
                        <div key={est.id} className="flex items-center justify-between border-b pb-3 last:border-none">
                          <div>
                            <div className="font-medium">{est.jobName || 'Untitled'}</div>
                            <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                          </div>
                          <Button size="sm" onClick={() => openExistingDocument(est)}>Open</Button>
                        </div>
                      ))}
                      {savedEstimatesList.length === 0 && <p className="text-gray-500 text-center py-8">No documents yet</p>}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-4">Recently Paid Invoices</h3>
                    <div className="space-y-3">
                      {invoicesList
                        .filter((inv) => inv.paymentStatus === 'paid')
                        .sort((a, b) => new Date(b.updated_at || b.date || 0).getTime() - new Date(a.updated_at || a.date || 0).getTime())
                        .slice(0, 5)
                        .map((inv) => (
                          <div key={inv.id} className="flex items-center justify-between border-b pb-3 last:border-none">
                            <div className="flex-1">
                              <div className="font-medium">{inv.jobName || 'Untitled'}</div>
                              <div className="text-sm text-gray-500">{inv.invoiceNumber} • {inv.date}</div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="px-3 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full">Paid</span>
                              <Button size="sm" onClick={() => openExistingDocument(inv)}>Open</Button>
                            </div>
                          </div>
                        ))}
                      {invoicesList.filter((inv) => inv.paymentStatus === 'paid').length === 0 && (
                        <p className="text-gray-500 text-center py-8">No paid invoices yet</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* All other views (editor, lists, profile, reports, etc.) are 100% unchanged from your original code */}
          {/* ... (the rest of your return statement is identical to what you had before) ... */}

        </div>

        {/* Bottom navigation unchanged */}
        {/* All modals unchanged */}
      </div>
    </>
  );
}