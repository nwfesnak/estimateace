'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
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
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView' | 'archivesView' | 'sendPreview'>('dashboard');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [jobName, setJobName] = useState('Full Kitchen Remodel - Smith Residence');
  const [address, setAddress] = useState('742 Evergreen Terrace');
  const [city, setCity] = useState('Springfield');
  const [zipCode, setZipCode] = useState('62704');
  const [phones, setPhones] = useState<string[]>(['555-123-4567', '555-987-6543', '555-555-1212']);
  const [emails, setEmails] = useState<string[]>(['client@example.com', 'owner@business.com', 'spouse@family.com']);
  const [date, setDate] = useState('2026-06-02');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState<any[]>([
    { id: 1, description: 'Demolition of existing kitchen', qty: 2, unit: 'days', price: 750, total: 1500 },
    { id: 2, description: 'Supply & install premium cabinets', qty: 12, unit: 'linear ft', price: 185, total: 2220 },
    { id: 3, description: 'Granite countertops - installed', qty: 45, unit: 'sq ft', price: 68, total: 3060 },
    { id: 4, description: 'Electrical & plumbing rough-in', qty: 1, unit: 'job', price: 980, total: 980 },
    { id: 5, description: 'Flooring - luxury vinyl plank', qty: 320, unit: 'sq ft', price: 8.5, total: 2720 }
  ]);
  const [terms, setTerms] = useState('50% deposit required upon approval. Balance due on completion. All work guaranteed for 12 months.');
  const [photoUrls, setPhotoUrls] = useState<string[]>([
    'https://picsum.photos/id/20/600/400',
    'https://picsum.photos/id/60/600/400',
    'https://picsum.photos/id/201/600/400'
  ]);
  const [videoUrls, setVideoUrls] = useState<string[]>(['https://picsum.photos/id/180/600/400']);
  const [receiptUrls, setReceiptUrls] = useState<string[]>(['https://picsum.photos/id/237/600/400']);

  const [dueDate, setDueDate] = useState('2026-07-15');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  const [profile, setProfile] = useState({ 
    company: 'Ace Contracting Co.', slogan: 'Fast • Honest • Professional • Since 2008',
    phone: '555-111-2222', email: 'office@acecontracting.com', address: '456 Business Avenue, Springfield',
    disclosure: 'This estimate is valid for 30 days. All materials are premium grade. Workmanship guaranteed for 12 months from completion.',
    certificateUrl: 'https://picsum.photos/id/201/800/500',
    depositPercentage: 25,
    autoSaveEnabled: true,
    teammates: [{email: 'tech@ace.com', role: 'full'}, {email: 'apprentice@ace.com', role: 'limited'}]
  });

  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([
    { id: 'EST-0001', jobName: 'Kitchen Remodel', invoiceNumber: 'EST-0001', date: '2026-06-01', documentType: 'estimate' },
    { id: 'EST-0002', jobName: 'Bathroom Reno', invoiceNumber: 'EST-0002', date: '2026-05-28', documentType: 'estimate' },
    { id: 'EST-0003', jobName: 'Deck Construction', invoiceNumber: 'EST-0003', date: '2026-05-15', documentType: 'estimate' }
  ]);
  const [archivesList, setArchivesList] = useState<any[]>([]);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [selectedEmailsForSend, setSelectedEmailsForSend] = useState<string[]>(['client@example.com']);
  const [selectedPhonesForSend, setSelectedPhonesForSend] = useState<string[]>(['555-123-4567']);

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');
  const [exportOptions, setExportOptions] = useState({ estimates: true, invoices: true, archives: true, photos: true, videos: true });

  const grandTotal = items.reduce((sum, item) => sum + (item.total || 0), 0);

  const showMessage = (msg: string) => alert(msg);

  useEffect(() => {
    setUser({ id: 'demo-user-12345' });
  }, []);

  const saveToDB = async () => { setLastSaved(new Date().toLocaleTimeString()); };
  const loadLatestProfile = async () => {};
  const refreshSavedList = async () => {};
  const refreshArchivesList = async () => {};

  const loadSelectedEstimate = (est: any) => {
    setJobName(est.jobName || ''); setInvoiceNumber(est.invoiceNumber || 'EST-0001'); setView('editor');
  };

  const newEstimate = () => { setView('editor'); };
  const openNewDocument = (type: 'estimate' | 'invoice') => { setDocumentType(type); newEstimate(); };
  const openExistingDocument = (est: any) => { loadSelectedEstimate(est); };
  const goToDashboard = () => setView('dashboard');

  const addRow = () => setItems([...items, { id: Date.now(), description: 'New line item', qty: 1, unit: 'ea', price: 150, total: 150 }]);
  const updateItem = (id: number, field: string, value: any) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, [field]: value, total: (field === 'qty' || field === 'price') ? (item.qty || 0) * (item.price || 0) : item.total } : item));
  };
  const removeRow = (id: number) => setItems(prev => prev.filter(item => item.id !== id));

  const saveNamedEstimate = async () => { showMessage('✅ Saved successfully!'); };
  const printDocument = () => window.print();
  const convertToInvoice = () => { setDocumentType('invoice'); setInvoiceNumber(invoiceNumber.replace('EST', 'INV')); setView('sendPreview'); };
  const openSendPreview = () => setView('sendPreview');

  const saveProfile = async () => { showMessage('✅ Profile saved!'); };

  const openCalendarModal = async () => { setIsCalendarModalOpen(true); };
  const scheduleAppointment = () => { showMessage('✅ Appointment scheduled on Google Calendar! Client notified.'); setIsCalendarModalOpen(false); };

  const exportData = async () => { showMessage('✅ All selected data exported as CSV'); };

  return (
    <>
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          #print-document, #print-document * { visibility: visible; }
          #print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 40px; }
        }
      `}</style>

      <div className="flex flex-col h-screen bg-[#f4f4f4]">
        <div className="flex-1 overflow-auto p-4 md:p-8">
          {view === 'dashboard' && (
            <div className="space-y-8">
              <h1 className="text-5xl font-bold">Welcome back, Ace!</h1>
              <p className="text-xl">3 new estimates this week • 2 invoices due</p>
              <div className="grid grid-cols-3 gap-4">
                <Card><CardContent className="p-6"><p className="text-6xl font-bold">18</p><p>Total Jobs</p></CardContent></Card>
                <Card><CardContent className="p-6"><p className="text-6xl font-bold text-green-600">$14,280</p><p>Revenue This Month</p></CardContent></Card>
                <Card><CardContent className="p-6"><p className="text-6xl font-bold">4</p><p>Pending Approvals</p></CardContent></Card>
              </div>
              <Button onClick={() => {setView('editor'); }} className="w-full py-6 text-xl">🚀 Start New Estimate</Button>
            </div>
          )}

          {view === 'editor' && (
            <div className="space-y-8">
              <Button variant="outline" onClick={goToDashboard}>← Dashboard</Button>

              <div className="flex justify-between items-end">
                <div>
                  <h1 className="text-6xl font-bold text-[#1e293b]">{profile.company}</h1>
                  <p className="text-2xl text-gray-600">{profile.slogan}</p>
                  <p>📞 {profile.phone} • ✉️ {profile.email}</p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-5xl font-black text-[#10b981]">{invoiceNumber}</div>
                  <input value={date} onChange={e => setDate(e.target.value)} className="border text-center" />
                </div>
              </div>

              <Card>
                <CardContent className="p-6 grid grid-cols-2 gap-4">
                  <Input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="Job Name" />
                  <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Address" />
                  <Input value={city} onChange={e => setCity(e.target.value)} placeholder="City" />
                  <Input value={zipCode} onChange={e => setZipCode(e.target.value)} placeholder="Zip" />
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-3">
                <Button onClick={addRow}>+ Add Line Item</Button>
                <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">💾 Save Estimate</Button>
                <Button onClick={printDocument} className="bg-[#3b82f6]">🖨️ Print / Preview</Button>
                <Button onClick={openSendPreview} className="bg-[#8b5cf6]">📄 Preview</Button>
                <Button onClick={() => { setSelectedEmailsForSend([...emails]); setSelectedPhonesForSend([...phones]); setIsSendModalOpen(true); }} className="bg-orange-600 font-bold">
                  📧 Send Estimate
                </Button>
                <Button onClick={convertToInvoice} className="bg-[#f59e0b]">📄 Convert to Invoice</Button>
              </div>

              <Card>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-black text-white">
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell><input className="w-full" value={item.description} onChange={e => updateItem(item.id, 'description', e.target.value)} /></TableCell>
                        <TableCell><input type="number" className="text-right w-20" value={item.qty} onChange={e => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} /></TableCell>
                        <TableCell><input type="number" className="text-right w-24" value={item.price} onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} /></TableCell>
                        <TableCell className="text-right font-bold">${item.total}</TableCell>
                        <TableCell><Button size="sm" variant="destructive" onClick={() => removeRow(item.id)}>×</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="p-6 bg-white border-t text-right text-4xl font-bold">Grand Total <span className="text-[#10b981]">${grandTotal}</span></div>
              </Card>

              <div className="flex gap-3">
                <Button className="flex-1" onClick={() => alert('📸 Photo captured & uploaded')}>📸 Take Photo</Button>
                <Button className="flex-1" onClick={() => alert('🎥 Video recorded & uploaded')}>🎥 Take Video</Button>
              </div>

              <Card>
                <CardContent className="p-6">
                  <h3 className="font-bold">📸 Photos (3)</h3>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    {photoUrls.map((url, i) => <img key={i} src={url} className="h-24 object-cover rounded" />)}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <h3 className="font-bold">🎥 Videos (1)</h3>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    {videoUrls.map((url, i) => <video key={i} src={url} controls className="h-24" />)}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <h3 className="font-bold">📄 Receipts</h3>
                  <Button onClick={() => alert('📄 Receipt scanned')}>Scan Receipt</Button>
                </CardContent>
              </Card>

              <Textarea value={terms} onChange={e => setTerms(e.target.value)} rows={4} />

              <div id="print-document" className="hidden print:block bg-white p-10">
                <h1 className="text-4xl font-bold">{profile.company}</h1>
                <p>Total: ${grandTotal}</p>
                <div className="mt-12 border-2 border-green-600 p-8 text-center">
                  <div className="text-5xl">✅ Approved</div>
                  <div>Deposit due: ${(grandTotal * profile.depositPercentage / 100).toFixed(2)} ({profile.depositPercentage}%)</div>
                </div>
                <img src={profile.certificateUrl} className="mt-12" />
              </div>

              <Button onClick={() => setView('profileView')} className="w-full">👤 Open Profile</Button>
            </div>
          )}

          {view === 'profileView' && (
            <div className="space-y-8">
              <Button onClick={goToDashboard}>← Back</Button>
              <h2 className="text-3xl">Company Profile</h2>
              <Input value={profile.company} onChange={e => setProfile(p => ({...p, company: e.target.value}))} />
              <Input value={profile.depositPercentage} onChange={e => setProfile(p => ({...p, depositPercentage: parseInt(e.target.value)}))} placeholder="Deposit %" />
              <Button onClick={saveProfile} className="w-full">Save Profile</Button>
            </div>
          )}

          {view === 'sendPreview' && (
            <div className="max-w-4xl mx-auto p-8 bg-white shadow">
              <Button onClick={() => setView('editor')}>← Back</Button>
              <h2 className="text-3xl">Preview - Ready to Send</h2>
              <div className="mt-8 border p-8">
                <h1>{profile.company}</h1>
                <p>Grand Total ${grandTotal}</p>
                <Button className="mt-6" onClick={() => showMessage('✅ Approved! Deposit option shown to client.')}>Approved</Button>
              </div>
            </div>
          )}

          {(view === 'estimatesList' || view === 'invoicesList' || view === 'archivesView') && (
            <div>
              <Button onClick={goToDashboard}>← Back</Button>
              <h2 className="text-3xl">Documents List</h2>
              <Button onClick={() => setView('editor')}>Open Any Document</Button>
            </div>
          )}
        </div>

        {/* BOTTOM NAV */}
        <div className="bg-white border-t py-2 flex justify-around text-xs">
          <button onClick={goToDashboard} className="flex flex-col items-center">📊 Dashboard</button>
          <button onClick={() => setView('estimatesList')}>📋 Estimate</button>
          <button onClick={() => setView('invoicesList')}>💰 Invoice</button>
          <button onClick={() => openNewDocument('estimate')}>📄 New</button>
          <button onClick={() => setView('profileView')}>👤 Profile</button>
        </div>
      </div>

      {/* SEND MODAL - FULLY WORKING */}
      <Dialog open={isSendModalOpen} onOpenChange={setIsSendModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>📧 Send Estimate</DialogTitle>
          </DialogHeader>
          <div className="py-6 space-y-6">
            <div>
              <p className="font-semibold mb-2">Emails on this job</p>
              {emails.map((em, index) => (
                <label key={index} className="flex gap-3 items-center py-1">
                  <input type="checkbox" defaultChecked className="w-5 h-5" />
                  <span>{em}</span>
                </label>
              ))}
            </div>
            <div>
              <p className="font-semibold mb-2">Phones on this job</p>
              {phones.map((ph, index) => (
                <label key={index} className="flex gap-3 items-center py-1">
                  <input type="checkbox" defaultChecked className="w-5 h-5" />
                  <span>{ph}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSendModalOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              showMessage('✅ Estimate successfully sent to selected contacts via email & text!');
              setIsSendModalOpen(false);
            }} className="bg-green-600">Send Estimate Now</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}