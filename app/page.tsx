'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// ==================== IndexedDB Configuration ====================
const DB_NAME = 'estimateace';
const DB_VERSION = 2;
let dbInstance: IDBDatabase | null = null;

const initDB = async (): Promise<IDBDatabase> => {
  if (dbInstance) return dbInstance;  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('currentEstimate')) db.createObjectStore('currentEstimate', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('savedEstimates')) db.createObjectStore('savedEstimates', { keyPath: 'id' });
    };
    request.onsuccess = (e) => { dbInstance = (e.target as IDBOpenDBRequest).result; resolve(dbInstance); };
    request.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
};

// ==================== Database Helpers ====================
const saveEstimateToDB = async (data: any) => {
  const db = await initDB();
  const tx = db.transaction('currentEstimate', 'readwrite');
  tx.objectStore('currentEstimate').put({ id: 'current', ...data });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
};

const loadEstimateFromDB = async (): Promise<any | null> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('currentEstimate', 'readonly');
    const request = tx.objectStore('currentEstimate').get('current');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
};

const saveMediaToDB = async (file: File, type: 'photo' | 'video' | 'receipt'): Promise<string> => {
  const db = await initDB();
  const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').add({ id, blob: file, type });
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
};

const getMediaFromDB = async (id: string): Promise<string> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readonly');
    const request = tx.objectStore('media').get(id);
    request.onsuccess = () => resolve(request.result ? URL.createObjectURL(request.result.blob) : '');
    request.onerror = () => reject(request.error);
  });
};

const deleteMediaFromDB = async (id: string) => {
  const db = await initDB();
  const tx = db.transaction('media', 'readwrite');
  tx.objectStore('media').delete(id);
};

const saveAsNamedEstimate = async (name: string, currentData: any) => {
  const db = await initDB();
  const id = `saved-${Date.now()}`;
  const record = { id, name: name || currentData.jobName || 'Untitled', invoiceNumber: currentData.invoiceNumber, jobName: currentData.jobName, date: currentData.date, savedAt: new Date().toISOString(), data: currentData };
  const tx = db.transaction('savedEstimates', 'readwrite');
  tx.objectStore('savedEstimates').put(record);
  return new Promise((resolve) => { tx.oncomplete = () => resolve(true); });
};

const loadSavedEstimates = async (): Promise<any[]> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('savedEstimates', 'readonly');
    const request = tx.objectStore('savedEstimates').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
};

const deleteSavedEstimate = async (id: string) => {
  const db = await initDB();
  const tx = db.transaction('savedEstimates', 'readwrite');
  tx.objectStore('savedEstimates').delete(id);
};

// ==================== Main Component ====================
export default function Home() {
  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const [terms, setTerms] = useState('');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [videoIds, setVideoIds] = useState<string[]>([]);
  const [receiptIds, setReceiptIds] = useState<string[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);

  const [profile, setProfile] = useState({
    name: '',
    company: '',
    address: '',
    phone: '',
    email: '',
    slogan: '',
    showInHeader: false,
    showQuickLineButtons: true,
  });

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; text: string }[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState('Never');
  const [showSaveConfirmation, setShowSaveConfirmation] = useState(false);
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);

  const grandTotal = items.reduce((sum, item) => sum + (item.total || 0), 0);
  const amountDue = Math.max(grandTotal - amountPaid, 0);

  const improveWithGrok = async (id: number) => {
    const item = items.find((i) => i.id === id);
    if (!item?.description?.trim()) {
      alert("Type something first!");
      return;
    }

    try {
      const res = await fetch('/api/grok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: item.description }),
      });

      const data = await res.json();
      if (data.suggestion && data.suggestion.length > 10) {
        updateItem(id, 'description', data.suggestion);
        alert('✅ Grok improved your line item!');
      } else {
        alert('Grok gave a short response – try again with more detail.');
      }
    } catch (err) {
      alert('Could not reach Grok AI. Check GROK_API_KEY in .env.local');
    }
  };

  const convertToInvoice = () => {
    if (documentType === 'invoice') return;
    setDocumentType('invoice');
    const newNumber = invoiceNumber.replace('EST-', 'INV-');
    setInvoiceNumber(newNumber);

    const thirtyDays = new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    setDueDate(thirtyDays.toISOString().split('T')[0]);

    setPaymentStatus('pending');
    setAmountPaid(0);
    setPaymentMethod('');
    alert('✅ Switched to Invoice mode!');
  };

  const recordPayment = () => {
    if (amountPaid >= grandTotal) {
      setPaymentStatus('paid');
      alert(`✅ Payment of $${amountPaid.toFixed(2)} recorded via ${paymentMethod || 'Unknown'}. Invoice marked PAID!`);
    } else {
      alert(`✅ Partial payment of $${amountPaid.toFixed(2)} recorded. Amount still due: $${amountDue.toFixed(2)}`);
    }
    saveToDB();
  };

  const openGoogleCalendar = () => {
    const title = encodeURIComponent(`${documentType === 'invoice' ? 'Invoice' : 'Estimate'} - ${jobName || 'New Job'}`);
    const eventDate = date ? date.replace(/-/g, '') : new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startTime = `${eventDate}T080000`;
    const endTime = `${eventDate}T170000`;
    const details = encodeURIComponent(`EstimateAce #${invoiceNumber}\nJob: ${jobName}\nAddress: ${address}\n\nCreated with EstimateAce`);

    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startTime}/${endTime}&details=${details}`;
    window.open(url, '_blank');
  };

  const addRow = () => setItems([...items, { id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const updateItem = (id: number, field: string, value: any) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          const updated = { ...item, [field]: value };
          if (field === 'qty' || field === 'price') {
            updated.total = (updated.qty || 0) * (updated.price || 0);
          }
          return updated;
        }
        return item;
      })
    );
  };

  const removeRow = (id: number) => setItems((prev) => prev.filter((item) => item.id !== id));

  const newEstimate = async () => {
    if (!confirm('Start a completely new document?')) return;

    [...photoIds, ...videoIds, ...receiptIds].forEach((id) => deleteMediaFromDB(id));

    const db = await initDB();
    const tx = db.transaction('currentEstimate', 'readwrite');
    tx.objectStore('currentEstimate').delete('current');

    setJobName('');
    setAddress('');
    setPhones(['']);
    setEmails(['']);
    setTerms('');
    setPhotoIds([]);
    setVideoIds([]);
    setReceiptIds([]);
    setPhotoUrls([]);
    setVideoUrls([]);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);

    const savedCount = localStorage.getItem('estimateCount') || '0';
    const count = parseInt(savedCount) + 1;
    setInvoiceNumber(documentType === 'estimate' ? `EST-${String(count).padStart(4, '0')}` : `INV-${String(count).padStart(4, '0')}`);
    localStorage.setItem('estimateCount', count.toString());

    alert('✅ New document started!');
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video' | 'receipt') => {
    if (!files) return;

    const newIds: string[] = [];
    for (const file of Array.from(files)) {
      const id = await saveMediaToDB(file, type);
      newIds.push(id);
    }

    if (type === 'photo') setPhotoIds((prev) => [...prev, ...newIds]);
    else if (type === 'video') setVideoIds((prev) => [...prev, ...newIds]);
    else setReceiptIds((prev) => [...prev, ...newIds]);

    if (type === 'receipt') {
      alert('✅ Receipt uploaded!');
    }
  };

  const handlePhotos = (e: React.ChangeEvent<HTMLInputElement>) => handleMediaUpload(e.target.files, 'photo');
  const handleVideos = (e: React.ChangeEvent<HTMLInputElement>) => handleMediaUpload(e.target.files, 'video');
  const handleReceipts = (e: React.ChangeEvent<HTMLInputElement>) => handleMediaUpload(e.target.files, 'receipt');

  const removeMedia = (type: 'photo' | 'video' | 'receipt', index: number) => {
    let ids = type === 'photo' ? photoIds : type === 'video' ? videoIds : receiptIds;
    const idToDelete = ids[index];
    deleteMediaFromDB(idToDelete);

    if (type === 'photo') {
      setPhotoIds((prev) => prev.filter((_, i) => i !== index));
      setPhotoUrls((prev) => prev.filter((_, i) => i !== index));
    } else if (type === 'video') {
      setVideoIds((prev) => prev.filter((_, i) => i !== index));
      setVideoUrls((prev) => prev.filter((_, i) => i !== index));
    } else {
      setReceiptIds((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const addPhone = () => setPhones([...phones, '']);
  const removePhone = (i: number) => setPhones(phones.filter((_, idx) => idx !== i));
  const updatePhone = (i: number, value: string) => {
    const arr = [...phones];
    arr[i] = value;
    setPhones(arr);
  };

  const addEmail = () => setEmails([...emails, '']);
  const removeEmail = (i: number) => setEmails(emails.filter((_, idx) => idx !== i));
  const updateEmail = (i: number, value: string) => {
    const arr = [...emails];
    arr[i] = value;
    setEmails(arr);
  };

  const loadMediaPreviews = async () => {
    const p = await Promise.all(photoIds.map((id) => getMediaFromDB(id)));
    const v = await Promise.all(videoIds.map((id) => getMediaFromDB(id)));
    setPhotoUrls(p);
    setVideoUrls(v);
  };

  useEffect(() => {
    loadMediaPreviews();
  }, [photoIds, videoIds]);

  const saveToDB = async () => {
    const data = {
      jobName,
      address,
      phones,
      emails,
      date,
      invoiceNumber,
      items,
      terms,
      profile,
      photoIds,
      videoIds,
      receiptIds,
      documentType,
      dueDate,
      paymentStatus,
      amountPaid,
      paymentMethod,
    };
    await saveEstimateToDB(data);
    setLastSaved(new Date().toLocaleTimeString());
  };

  const forceSave = async () => {
    await saveToDB();
    setShowSaveConfirmation(true);
    setTimeout(() => setShowSaveConfirmation(false), 2000);
  };

  const saveNamedEstimate = async () => {
    const name = prompt(`Enter a name for this ${documentType === 'invoice' ? 'invoice' : 'estimate'}`);
    if (!name) return;

    const currentData = {
      jobName,
      address,
      phones,
      emails,
      date,
      invoiceNumber,
      items,
      terms,
      profile,
      photoIds,
      videoIds,
      receiptIds,
      documentType,
      dueDate,
      paymentStatus,
      amountPaid,
      paymentMethod,
    };

    await saveAsNamedEstimate(name, currentData);
    alert(`✅ Saved as "${name}"`);
    await refreshSavedList();
  };

  const refreshSavedList = async () => {
    const list = await loadSavedEstimates();
    setSavedEstimatesList(list);
  };

  const openLoadModal = async () => {
    await refreshSavedList();
    setIsLoadModalOpen(true);
  };

  const loadSelectedEstimate = async (saved: any) => {
    const data = saved.data;
    setJobName(data.jobName || '');
    setAddress(data.address || '');
    setPhones(data.phones || ['']);
    setEmails(data.emails || ['']);
    setDate(data.date || '');
    setInvoiceNumber(data.invoiceNumber || 'EST-0001');
    setItems(data.items || [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setTerms(data.terms || '');
    setProfile(data.profile || { name: '', company: '', address: '', phone: '', email: '', slogan: '', showInHeader: false, showQuickLineButtons: true });
    setPhotoIds(data.photoIds || []);
    setVideoIds(data.videoIds || []);
    setReceiptIds(data.receiptIds || []);
    setDocumentType(data.documentType || 'estimate');
    setDueDate(data.dueDate || '');
    setPaymentStatus(data.paymentStatus || 'pending');
    setAmountPaid(data.amountPaid || 0);
    setPaymentMethod(data.paymentMethod || '');
    setIsLoadModalOpen(false);
    alert('✅ Loaded successfully!');
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete permanently?')) return;
    await deleteSavedEstimate(id);
    await refreshSavedList();
  };

  const saveProfile = async () => {
    await saveToDB();
    setIsProfileOpen(false);
  };

  const printEstimate = () => window.print();
  const sendEstimate = () => alert(`✅ ${documentType === 'invoice' ? 'Invoice' : 'Estimate'} sent successfully!`);

  const useTemplate = (text: string) => {
    setTerms(text);
    setIsTemplatesOpen(false);
  };

  const saveAsTemplate = () => {
    if (!terms.trim()) return alert("Please enter some text first");
    const name = prompt("Enter a name for this template:");
    if (!name?.trim()) return;

    const newTemplate = { name: name.trim(), text: terms };
    const updated = [...savedTemplates, newTemplate];
    setSavedTemplates(updated);
    localStorage.setItem('templates', JSON.stringify(updated));
    alert(`✅ Template "${name}" saved!`);
  };

  useEffect(() => {
    loadEstimateFromDB().then((saved) => {
      if (saved) {
        setJobName(saved.jobName || '');
        setAddress(saved.address || '');
        setPhones(saved.phones || ['']);
        setEmails(saved.emails || ['']);
        setDate(saved.date || '');
        setInvoiceNumber(saved.invoiceNumber || 'EST-0001');
        setItems(saved.items || [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
        setTerms(saved.terms || '');
        setProfile(saved.profile || { name: '', company: '', address: '', phone: '', email: '', slogan: '', showInHeader: false, showQuickLineButtons: true });
        setPhotoIds(saved.photoIds || []);
        setVideoIds(saved.videoIds || []);
        setReceiptIds(saved.receiptIds || []);
        setDocumentType(saved.documentType || 'estimate');
        setDueDate(saved.dueDate || '');
        setPaymentStatus(saved.paymentStatus || 'pending');
        setAmountPaid(saved.amountPaid || 0);
        setPaymentMethod(saved.paymentMethod || '');
      }
      if (!date) setDate(new Date().toISOString().split('T')[0]);
    });

    const savedTemplatesStr = localStorage.getItem('templates');
    if (savedTemplatesStr) setSavedTemplates(JSON.parse(savedTemplatesStr));
  }, []);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedSave = () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    debouncedSave();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [jobName, address, phones, emails, date, invoiceNumber, items, terms, profile, photoIds, videoIds, receiptIds, documentType, dueDate, paymentStatus, amountPaid, paymentMethod]);

  return (
    <div className="min-h-screen bg-[#f4f4f4] p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white border rounded-xl p-4 mb-6 flex items-center justify-between text-sm">
          <div>
            💾 <span className="font-medium">Last saved:</span> {lastSaved}
          </div>
          <Button onClick={forceSave} size="sm" variant="outline">
            Force Save Now
          </Button>
        </div>

        <div className="flex border-b mb-8 bg-white rounded-t-xl overflow-hidden shadow-sm">
          <button
            onClick={() => setDocumentType('estimate')}
            className={`flex-1 py-5 text-xl font-semibold transition-all ${
              documentType === 'estimate' ? 'bg-[#1e293b] text-white shadow-inner' : 'hover:bg-gray-100'
            }`}
          >
            📋 Estimate
          </button>
          <button
            onClick={() => setDocumentType('invoice')}
            className={`flex-1 py-5 text-xl font-semibold transition-all ${
              documentType === 'invoice' ? 'bg-[#1e293b] text-white shadow-inner' : 'hover:bg-gray-100'
            }`}
          >
            💰 Invoice
          </button>
        </div>

        <div id="estimate-content" className="bg-[#1e293b] text-white p-6 rounded-xl mb-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-4xl font-bold">{documentType === 'invoice' ? 'INVOICE' : 'EstimateAce'}</h1>
              <span className="text-slate-400">Professional {documentType === 'invoice' ? 'Invoicing' : 'Estimating'}</span>
            </div>
            {profile.showInHeader && (
              <div className="text-right text-sm max-w-xs">
                <div className="font-semibold">{profile.company || profile.name}</div>
                {profile.slogan && <div className="text-xs italic text-slate-300 mb-1">{profile.slogan}</div>}
                <div className="text-xs text-slate-300">{profile.address}</div>
                <div className="text-xs text-slate-300">
                  {profile.phone} • {profile.email}
                </div>
              </div>
            )}
          </div>
        </div>

        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-semibold mb-2">Job Name / Client</label>
                <Input value={jobName} onChange={(e) => setJobName(e.target.value)} className="h-12" />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Address</label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-12" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-2">Date</label>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-12" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">Document #</label>
                  <Input value={invoiceNumber} className="h-12 font-mono" readOnly />
                </div>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div>
                <label className="block text-sm font-semibold mb-2">Phone Number(s)</label>
                {phones.map((phone, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <Input value={phone} onChange={(e) => updatePhone(i, e.target.value)} placeholder="(555) 123-4567" />
                    {phones.length > 1 && <Button variant="destructive" size="sm" onClick={() => removePhone(i)}>×</Button>}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addPhone}>+ Add Phone</Button>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Email Address(es)</label>
                {emails.map((email, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <Input value={email} onChange={(e) => updateEmail(i, e.target.value)} placeholder="client@email.com" />
                    {emails.length > 1 && <Button variant="destructive" size="sm" onClick={() => removeEmail(i)}>×</Button>}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addEmail}>+ Add Email</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 mb-8 flex-wrap">
          <Button onClick={newEstimate} className="bg-[#6b7280]">
            🆕 New {documentType === 'invoice' ? 'Invoice' : 'Estimate'}
          </Button>
          <Button onClick={addRow} className="bg-[#10b981]">
            ➕ Add Line Item
          </Button>
          <Button onClick={openLoadModal} className="bg-[#3b82f6]">
            🔍 Load Document
          </Button>
          <Button variant="outline">⚡ Quick Lines</Button>
        </div>

        {/* Line Items Table - unchanged */}
        <Card className="mb-8">
          <style>{`
            @media (max-width: 768px) {
              table, thead, tbody, th, td, tr { display: block !important; }
              thead tr { display: none !important; }
              tr { margin-bottom: 24px !important; border: 2px solid #e2e8f0 !important; border-radius: 16px !important; background: white !important; box-shadow: 0 4px 15px rgba(0,0,0,0.1) !important; padding: 18px !important; }
              td { display: flex !important; flex-direction: column !important; padding: 12px 0 !important; border: none !important; }
              td:before { content: attr(data-label) !important; font-weight: 700 !important; font-size: 1.05rem !important; color: #1e293b !important; margin-bottom: 8px !important; }
              .description-cell textarea { min-height: 240px !important; font-size: 1.1rem !important; }
            }
          `}</style>

          <Table>
            <TableHeader>
              <TableRow className="bg-[#1e293b] text-white">
                <TableHead className="w-[55%] bg-[#1e293b] text-white font-bold text-center">Description</TableHead>
                <TableHead className="w-[9%] bg-[#1e293b] text-white font-bold text-center">Qty</TableHead>
                <TableHead className="w-[9%] bg-[#1e293b] text-white font-bold text-center">Unit</TableHead>
                <TableHead className="w-[9%] bg-[#1e293b] text-white font-bold text-center">Price</TableHead>
                <TableHead className="w-[9%] bg-[#1e293b] text-white font-bold text-right">Total</TableHead>
                <TableHead className="w-[9%] bg-[#1e293b] text-white font-bold">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell data-label="Description" className="description-cell">
                    <div className="relative">
                      <Textarea
                        value={item.description}
                        onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                        className="min-h-[100px] bg-white text-gray-900 font-medium border border-gray-300 focus:border-blue-500 w-full pr-12"
                      />
                      <Button
                        onClick={() => improveWithGrok(item.id)}
                        size="sm"
                        className="absolute top-3 right-3 bg-[#10b981] hover:bg-[#0f9e6e] text-white text-xs px-3 py-1"
                      >
                        🤖 Grok AI
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell data-label="Qty" className="text-center">
                    <Input type="number" value={item.qty} onChange={(e) => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} />
                  </TableCell>
                  <TableCell data-label="Unit" className="text-center">
                    <Input value={item.unit} onChange={(e) => updateItem(item.id, 'unit', e.target.value)} />
                  </TableCell>
                  <TableCell data-label="Price" className="text-center">
                    <Input type="number" step="0.01" value={item.price} onChange={(e) => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} />
                  </TableCell>
                  <TableCell data-label="Total" className="text-right font-semibold">
                    ${(item.total || 0).toFixed(2)}
                  </TableCell>
                  <TableCell data-label="Action">
                    <div className="flex gap-1">
                      {profile.showQuickLineButtons && (
                        <Button size="sm" variant="outline" onClick={() => alert('💾 Saved to Quick Lines!')} className="text-green-600 hover:text-green-700">
                          💾
                        </Button>
                      )}
                      <Button variant="destructive" size="sm" onClick={() => removeRow(item.id)}>
                        ×
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="p-6 bg-white border-t text-right">
            <div className="text-3xl font-bold">
              {documentType === 'invoice' ? 'Amount Due: ' : 'Grand Total: '}
              <span className="text-[#10b981]">${amountDue.toFixed(2)}</span>
            </div>
          </div>

          {documentType === 'invoice' && (
            <div className="p-6 bg-white border-t">
              <h3 className="font-semibold text-lg mb-4">💳 Record Payment</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium mb-2">Payment Method</label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Cash">Cash</SelectItem>
                      <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                      <SelectItem value="Credit Card">Credit Card</SelectItem>
                      <SelectItem value="PayPal">PayPal</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Amount Paid</label>
                  <Input type="number" step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(parseFloat(e.target.value) || 0)} />
                </div>
                <div className="flex items-end">
                  <Button onClick={recordPayment} className="w-full bg-[#10b981]">
                    ✅ Record Payment
                  </Button>
                </div>
              </div>
              {paymentStatus === 'paid' && <div className="mt-4 text-green-600 font-bold text-center text-lg">🎉 INVOICE PAID IN FULL</div>}
            </div>
          )}

          {/* Bottom Actions - Take Photo and Record Video moved here to the LEFT of Save Estimate */}
          <div className="p-6 bg-white border-t flex justify-between items-center gap-3 flex-wrap">
            {/* Camera buttons on the left */}
            <div className="flex gap-3">
              <Button onClick={() => document.getElementById('photo-camera')?.click()} className="bg-[#10b981]">
                📷 Take Photo
              </Button>
              <Button onClick={() => document.getElementById('video-camera')?.click()} className="bg-[#10b981]">
                📹 Record Video
              </Button>
            </div>

            {/* Original action buttons on the right */}
            <div className="flex gap-3 flex-wrap">
              <Button onClick={saveNamedEstimate} className="bg-[#10b981]">
                💾 Save {documentType === 'invoice' ? 'Invoice' : 'Estimate'}
              </Button>
              <Button onClick={sendEstimate} className="bg-[#2563eb]">
                📧 Send {documentType === 'invoice' ? 'Invoice' : 'Estimate'}
              </Button>
              <Button onClick={printEstimate} className="bg-[#10b981]">
                🖨️ Print
              </Button>
            </div>
          </div>
        </Card>

        {/* Photos card - file input only (button moved) */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">📸 Photos</h3>
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={handlePhotos}
              className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0f9e6e]"
            />
            <input id="photo-camera" type="file" accept="image/*" capture="environment" onChange={handlePhotos} className="hidden" />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {photoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="photo" className="w-full h-32 object-cover rounded-lg border" />
                  <Button variant="destructive" size="sm" className="absolute -top-2 -right-2" onClick={() => removeMedia('photo', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Videos card - file input only (button moved) */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">🎥 Videos</h3>
            <input
              type="file"
              multiple
              accept="video/*"
              onChange={handleVideos}
              className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0f9e6e]"
            />
            <input id="video-camera" type="file" accept="video/*" capture="environment" onChange={handleVideos} className="hidden" />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              {videoUrls.map((src, i) => (
                <div key={i} className="relative">
                  <video src={src} controls className="w-full h-32 object-cover rounded-lg border" />
                  <Button variant="destructive" size="sm" className="absolute -top-2 -right-2" onClick={() => removeMedia('video', i)}>×</Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Disclosures & Quick Actions - unchanged */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-3">Disclosures and Standard Contractor Terms</h3>
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Enter your standard terms, warranties, payment policies, disclosures..."
              className="min-h-[180px] mb-8"
            />

            <h4 className="text-base font-semibold mb-4 text-center md:text-left text-gray-600">Quick Actions</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <Button onClick={() => setIsTemplatesOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#3b82f6] hover:bg-[#2563eb] text-white">
                <span className="text-4xl">📋</span>
                <span className="font-medium">Templates</span>
              </Button>

              <Button onClick={saveAsTemplate} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#6b7280] hover:bg-[#4b5563] text-white">
                <span className="text-4xl">💾</span>
                <span className="font-medium">Save as Template</span>
              </Button>

              <Button onClick={() => setIsProfileOpen(true)} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white">
                <span className="text-4xl">👤</span>
                <span className="font-medium">Profile</span>
              </Button>

              <Button className="h-24 flex flex-col items-center justify-center gap-2 bg-[#10b981] hover:bg-[#059669] text-white">
                <span className="text-4xl">📊</span>
                <span className="font-medium">Dashboard</span>
              </Button>

              <Button onClick={openGoogleCalendar} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#4285F4] hover:bg-[#1e40af] text-white">
                <span className="text-4xl">📅</span>
                <span className="font-medium">Calendar</span>
              </Button>

              <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="h-24 flex flex-col items-center justify-center gap-2 bg-[#f59e0b] hover:bg-[#d97706] text-white">
                <span className="text-4xl">📸</span>
                <span className="font-medium">Receipts</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <input id="receipts-camera" type="file" accept="image/*" capture="environment" onChange={handleReceipts} className="hidden" />

      {/* Load Modal, Profile Modal, Templates Modal - unchanged */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader><DialogTitle>🔍 Load Saved Document</DialogTitle></DialogHeader>
          <div className="max-h-[500px] overflow-y-auto">
            {savedEstimatesList.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No saved documents yet.<br />Click “Save” to create one.</p>
            ) : (
              <div className="space-y-3">
                {savedEstimatesList.map((est) => (
                  <div key={est.id} className="flex items-center justify-between p-4 border rounded-xl hover:bg-gray-50">
                    <div>
                      <div className="font-semibold">{est.invoiceNumber} — {est.jobName}</div>
                      <div className="text-xs text-gray-500">Date: {est.date} • Saved: {new Date(est.savedAt).toLocaleString()}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => loadSelectedEstimate(est)}>Load</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isProfileOpen} onOpenChange={setIsProfileOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>👤 Company Profile</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><label className="block text-sm font-semibold mb-1">Name</label><Input value={profile.name} onChange={(e) => setProfile({...profile, name: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Company Name</label><Input value={profile.company} onChange={(e) => setProfile({...profile, company: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Address</label><Input value={profile.address} onChange={(e) => setProfile({...profile, address: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Phone</label><Input value={profile.phone} onChange={(e) => setProfile({...profile, phone: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Email</label><Input value={profile.email} onChange={(e) => setProfile({...profile, email: e.target.value})} /></div>
            <div><label className="block text-sm font-semibold mb-1">Slogan</label><Input value={profile.slogan} onChange={(e) => setProfile({...profile, slogan: e.target.value})} /></div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Display company info in header</label>
              <input type="checkbox" checked={profile.showInHeader} onChange={(e) => setProfile({...profile, showInHeader: e.target.checked})} className="w-5 h-5 accent-blue-600" />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Enable Save Quick Line buttons (💾)</label>
              <input type="checkbox" checked={profile.showQuickLineButtons} onChange={(e) => setProfile({...profile, showQuickLineButtons: e.target.checked})} className="w-5 h-5 accent-blue-600" />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={saveProfile} className="bg-[#10b981]">Save Profile</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isTemplatesOpen} onOpenChange={setIsTemplatesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>📋 Templates</DialogTitle></DialogHeader>
          <div className="max-h-[400px] overflow-y-auto space-y-3">
            <div className="font-medium text-sm text-gray-500">Pre-made Templates</div>
            {[
              { name: 'Standard Payment Terms', text: '50% deposit due upon signing. Remaining 50% due upon completion.' },
              { name: 'Warranty', text: 'All workmanship is guaranteed for 12 months from date of completion.' },
            ].map((tpl, i) => (
              <div key={i} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                <div className="flex-1">
                  <div className="font-medium">{tpl.name}</div>
                  <div className="text-xs text-gray-500 line-clamp-2">{tpl.text}</div>
                </div>
                <Button size="sm" onClick={() => useTemplate(tpl.text)}>Use</Button>
              </div>
            ))}
            {savedTemplates.length > 0 && (
              <>
                <div className="font-medium text-sm text-gray-500 mt-6">Your Saved Templates</div>
                {savedTemplates.map((tpl, i) => (
                  <div key={i} className="flex justify-between items-center p-3 border rounded-lg hover:bg-gray-50">
                    <div className="flex-1">
                      <div className="font-medium">{tpl.name}</div>
                      <div className="text-xs text-gray-500 line-clamp-2">{tpl.text}</div>
                    </div>
                    <Button size="sm" onClick={() => useTemplate(tpl.text)}>Use</Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}