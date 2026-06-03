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
  const [view, setView] = useState<'dashboard' | 'editor' | 'estimatesList' | 'invoicesList' | 'profileView' | 'archivesView' | 'sendPreview' | 'reportsView'>('dashboard');

  // Login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(true);

  // Document states
  const [documentType, setDocumentType] = useState<'estimate' | 'invoice'>('estimate');
  const [jobName, setJobName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [phones, setPhones] = useState<string[]>(['']);
  const [emails, setEmails] = useState<string[]>(['']);
  const [date, setDate] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('EST-0001');
  const [items, setItems] = useState<any[]>([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const [terms, setTerms] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);
  const [receiptDetails, setReceiptDetails] = useState<any[]>([]);

  const [dueDate, setDueDate] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'paid'>('pending');
  const [amountPaid, setAmountPaid] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('');

  // Labor states
  const [isLaborModalOpen, setIsLaborModalOpen] = useState(false);
  const [laborHours, setLaborHours] = useState(0);
  const [laborRate, setLaborRate] = useState(0);
  const [laborFixedAmount, setLaborFixedAmount] = useState(0);
  const [useHourlyLabor, setUseHourlyLabor] = useState(true);
  const laborAmount = useHourlyLabor ? laborHours * laborRate : laborFixedAmount;

  // Tax states
  const taxRates: { [key: string]: number } = {
    'AL': 4, 'AK': 0, 'AZ': 5.6, 'AR': 6.5, 'CA': 7.25,
    'CO': 2.9, 'CT': 6.35, 'DE': 0, 'FL': 6, 'GA': 4,
    'HI': 4, 'ID': 6, 'IL': 6.25, 'IN': 7, 'IA': 6,
    'KS': 6.5, 'KY': 6, 'LA': 4.45, 'ME': 5.5, 'MD': 6,
    'MA': 6.25, 'MI': 6, 'MN': 6.875, 'MS': 7, 'MO': 4.225,
    'MT': 0, 'NE': 5.5, 'NV': 6.85, 'NH': 0, 'NJ': 6.625,
    'NM': 5.125, 'NY': 4, 'NC': 4.75, 'ND': 5, 'OH': 5.75,
    'OK': 4.5, 'OR': 0, 'PA': 6, 'RI': 7, 'SC': 6,
    'SD': 4.5, 'TN': 7, 'TX': 6.25, 'UT': 4.85, 'VT': 6,
    'VA': 4.3, 'WA': 6.5, 'WV': 6, 'WI': 5, 'WY': 4,
  };
  const taxRate = taxRates[state.toUpperCase()] || 7;
  const subtotal = items.reduce((sum, item) => sum + (item.total || 0), 0) + laborAmount;
  const taxAmount = subtotal * (taxRate / 100);
  const grandTotal = subtotal + taxAmount;

  // Profile
  const [profile, setProfile] = useState({ 
    name: '', company: '', address: '', phone: '', email: '', slogan: '',
    disclosure: '',
    certificateUrl: '',
    depositPercentage: 10,
    autoSaveEnabled: true,
    teammates: [] as { email: string; role: 'full' | 'limited' }[]
  });

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; text: string }[]>([]);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState('Never');
  const [isLoadModalOpen, setIsLoadModalOpen] = useState(false);
  const [savedEstimatesList, setSavedEstimatesList] = useState<any[]>([]);
  const [archivesList, setArchivesList] = useState<any[]>([]);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [selectedEmailsForSend, setSelectedEmailsForSend] = useState<string[]>([]);
  const [selectedPhonesForSend, setSelectedPhonesForSend] = useState<string[]>([]);

  const [quickLines, setQuickLines] = useState<any[]>([]);
  const [isQuickLinesModalOpen, setIsQuickLinesModalOpen] = useState(false);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [selectedEstimateForCalendar, setSelectedEstimateForCalendar] = useState<any>(null);
  const [selectedDateTime, setSelectedDateTime] = useState('');

  // Receipt extraction modal
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

  // Reports view selected estimate
  const [selectedReportJob, setSelectedReportJob] = useState<any>(null);

  const showMessage = (message: string) => {
    const clean = message.replace(/^[^\s]*\.vercel\.app says:\s*/i, '').trim();
    alert(clean);
  };

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => setUser(session?.user ?? null));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  const login = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) showMessage(error.message);
    else setShowLogin(false);
  };

  const signup = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) showMessage(error.message);
    else showMessage('Account created!');
  };

  const saveToDB = async () => {
    if (!user || !supabase) return;
    const data = {
      user_id: user.id,
      jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber,
      items, terms, profile, documentType, dueDate, paymentStatus, amountPaid,
      paymentMethod, photoUrls, videoUrls, receiptUrls, receiptDetails,
      taxRate, taxAmount,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from('estimates').upsert({ id: invoiceNumber, ...data });
    if (error) console.error('Save error:', error);
    else {
      setLastSaved(new Date().toLocaleTimeString());
      refreshSavedList();
    }
  };

  const handleMediaUpload = async (files: FileList | null, type: 'photo' | 'video' | 'receipt') => {
    if (!files || !user || !supabase) return;
    const newUrls: string[] = [];
    for (const file of Array.from(files)) {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/${type}/${Date.now()}.${fileExt}`;
      const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
      if (!error) {
        const { data } = supabase.storage.from('media').getPublicUrl(filePath);
        newUrls.push(data.publicUrl);
      }
    }
    if (type === 'photo') setPhotoUrls(prev => [...prev, ...newUrls]);
    else if (type === 'video') setVideoUrls(prev => [...prev, ...newUrls]);
    else if (type === 'receipt') {
      setReceiptUrls(prev => [...prev, ...newUrls]);
      if (newUrls.length > 0) {
        setCurrentReceiptUrl(newUrls[0]);
        setTempReceiptData({ date: '', vendor: '', amount: 0, notes: '' });
        setIsReceiptExtractModalOpen(true);
      }
    }
    await saveToDB();
  };

  const saveReceiptExtraction = () => {
    if (!currentReceiptUrl) return;
    const newDetail = {
      url: currentReceiptUrl,
      date: tempReceiptData.date,
      vendor: tempReceiptData.vendor,
      amount: parseFloat(tempReceiptData.amount.toString()) || 0,
      notes: tempReceiptData.notes
    };
    setReceiptDetails(prev => [...prev, newDetail]);
    setIsReceiptExtractModalOpen(false);
    saveToDB();
    showMessage('✅ Receipt data saved to database');
  };

  const handleCertificateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !supabase) return;
    const filePath = `${user.id}/certificate/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage.from('media').upload(filePath, file, { upsert: true });
    if (!error) {
      const { data } = supabase.storage.from('media').getPublicUrl(filePath);
      setProfile(prev => ({ ...prev, certificateUrl: data.publicUrl }));
      showMessage('✅ Certificate of Insurance uploaded');
      await saveToDB();
    }
  };

  const removeMedia = (type: 'photo' | 'video' | 'receipt', index: number) => {
    if (type === 'photo') setPhotoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'video') setVideoUrls(prev => prev.filter((_, i) => i !== index));
    else if (type === 'receipt') {
      setReceiptUrls(prev => prev.filter((_, i) => i !== index));
      setReceiptDetails(prev => prev.filter((_, i) => i !== index));
    }
    saveToDB();
  };

  const refreshSavedList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('estimates').select('*').eq('user_id', user.id).order('updated_at', { ascending: false });
    setSavedEstimatesList(data || []);
  };

  const refreshArchivesList = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase.from('archive-est').select('*').eq('user_id', user.id).order('archived_at', { ascending: false });
    setArchivesList(data || []);
  };

  const loadSelectedEstimate = (est: any) => {
    setJobName(est.jobName || '');
    setAddress(est.address || '');
    setCity(est.city || '');
    setState(est.state || '');
    setZipCode(est.zipCode || '');
    setPhones(est.phones || ['']);
    setEmails(est.emails || ['']);
    setDate(est.date || '');
    setInvoiceNumber(est.invoiceNumber || 'EST-0001');
    setItems(est.items || [{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setTerms(est.terms || '');
    setProfile(est.profile || profile);
    setDocumentType(est.documentType || 'estimate');
    setDueDate(est.dueDate || '');
    setPaymentStatus(est.paymentStatus || 'pending');
    setAmountPaid(est.amountPaid || 0);
    setPaymentMethod(est.paymentMethod || '');
    setPhotoUrls(est.photoUrls || []);
    setVideoUrls(est.videoUrls || []);
    setReceiptUrls(est.receiptUrls || []);
    setReceiptDetails(est.receiptDetails || []);
    setLaborHours(est.laborHours || 0);
    setLaborRate(est.laborRate || 0);
    setLaborFixedAmount(est.laborFixedAmount || 0);
    setUseHourlyLabor(est.useHourlyLabor !== false);
  };

  const loadLatestProfile = async () => {
    if (!user || !supabase) return;
    const { data } = await supabase
      .from('estimates')
      .select('profile')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (data && data[0] && data[0].profile) {
      setProfile(data[0].profile);
    }
  };

  const newEstimate = () => {
    setJobName(''); setAddress(''); setCity(''); setState(''); setZipCode('');
    setPhones(['']); setEmails(['']); setTerms('');
    setPhotoUrls([]); setVideoUrls([]); setReceiptUrls([]); setReceiptDetails([]);
    setItems([{ id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
    setLaborHours(0); setLaborRate(0); setLaborFixedAmount(0); setUseHourlyLabor(true);
    const today = new Date().toISOString().split('T')[0];
    setDate(today);
    const savedCount = parseInt(localStorage.getItem('estimateCount') || '0') + 1;
    localStorage.setItem('estimateCount', savedCount.toString());
    const prefix = documentType === 'invoice' ? 'INV' : 'EST';
    setInvoiceNumber(`${prefix}-${String(savedCount).padStart(4, '0')}`);
    loadLatestProfile();
  };

  const openNewDocument = (type: 'estimate' | 'invoice') => {
    setDocumentType(type);
    newEstimate();
    setView('editor');
  };

  const openExistingDocument = (est: any) => {
    loadSelectedEstimate(est);
    setView('editor');
  };

  const goToDashboard = () => setView('dashboard');

  const openQuickLinesModal = () => setIsQuickLinesModalOpen(true);

  const addRow = () => setItems([...items, { id: Date.now(), description: '', qty: 1, unit: '', price: 0, total: 0 }]);
  const updateItem = (id: number, field: string, value: any) => {
    setItems(prev => prev.map(item => {
      if (item.id === id) {
        const updatedItem = { ...item, [field]: value };
        if (field === 'qty' || field === 'price') {
          const qty = field === 'qty' ? (parseFloat(value) || 0) : (item.qty || 0);
          const price = field === 'price' ? (parseFloat(value) || 0) : (item.price || 0);
          updatedItem.total = qty * price;
        }
        return updatedItem;
      }
      return item;
    }));
  };
  const removeRow = (id: number) => setItems(prev => prev.filter(item => item.id !== id));

  const addPhone = () => setPhones([...phones, '']);
  const removePhone = (i: number) => setPhones(phones.filter((_, idx) => idx !== i));
  const updatePhone = (i: number, value: string) => { const arr = [...phones]; arr[i] = value; setPhones(arr); };
  const addEmail = () => setEmails([...emails, '']);
  const removeEmail = (i: number) => setEmails(emails.filter((_, idx) => idx !== i));
  const updateEmail = (i: number, value: string) => { const arr = [...emails]; arr[i] = value; setEmails(arr); };

  const saveNamedEstimate = async () => {
    await saveToDB();
    showMessage(`✅ Saved as "${jobName || 'Untitled'} - ${invoiceNumber}"`);
  };

  const printDocument = () => window.print();

  const convertToInvoice = () => {
    setDocumentType('invoice');
    if (invoiceNumber.startsWith('EST-')) setInvoiceNumber(invoiceNumber.replace('EST-', 'INV-'));
    setView('sendPreview');
  };

  const openSendPreview = () => {
    setView('sendPreview');
  };

  const saveProfile = async () => {
    await saveToDB();
    await loadLatestProfile();
    showMessage('✅ Profile saved!');
  };

  const openCalendarModal = async () => {
    await refreshSavedList();
    setIsCalendarModalOpen(true);
  };

  const scheduleAppointment = () => {
    if (!selectedEstimateForCalendar || !selectedDateTime) return showMessage("Select estimate and date/time");
    const start = new Date(selectedDateTime);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Appointment%20for%20${encodeURIComponent(selectedEstimateForCalendar.jobName || 'Estimate')}&dates=${start.toISOString().replace(/[-:]/g, '').slice(0,15)}/${end.toISOString().replace(/[-:]/g, '').slice(0,15)}&details=Estimate%20%23${encodeURIComponent(selectedEstimateForCalendar.invoiceNumber)}`;
    window.open(googleUrl, '_blank');
    showMessage(`✅ Appointment scheduled on Google Calendar!\n\nClient notified via email & text.`);
    setIsCalendarModalOpen(false);
    setSelectedEstimateForCalendar(null);
    setSelectedDateTime('');
  };

  const saveAsTemplate = () => {
    if (!terms.trim()) return showMessage("Enter text first");
    const name = prompt("Template name:");
    if (name) {
      const updated = [...savedTemplates, { name: name.trim(), text: terms }];
      setSavedTemplates(updated);
      localStorage.setItem('templates', JSON.stringify(updated));
      showMessage(`Template "${name}" saved!`);
    }
  };

  const saveAsQuickLine = (item: any) => {
    const newQuick = { id: Date.now(), description: item.description, qty: item.qty, unit: item.unit, price: item.price };
    const updated = [...quickLines, newQuick];
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
    showMessage('Quick line saved!');
  };

  const useQuickLine = (quick: any) => {
    const newItem = { id: Date.now(), description: quick.description, qty: quick.qty, unit: quick.unit, price: quick.price, total: quick.qty * quick.price };
    setItems(prev => [...prev, newItem]);
    setIsQuickLinesModalOpen(false);
  };

  const deleteQuickLine = (id: number) => {
    const updated = quickLines.filter(q => q.id !== id);
    setQuickLines(updated);
    localStorage.setItem('quickLines', JSON.stringify(updated));
  };

  const deleteSelectedEstimate = async (id: string) => {
    if (!confirm('Delete permanently?')) return;
    if (!supabase) return;
    await supabase.from('estimates').delete().eq('id', id);
    await refreshSavedList();
    showMessage('Document deleted');
  };

  const archiveEstimate = async (id: string) => {
    if (!confirm('Archive this document?')) return;
    if (!user || !supabase) return;

    const { data: est } = await supabase.from('estimates').select('*').eq('id', id).single();
    if (!est) return;

    const archiveData = { ...est, archived_at: new Date().toISOString(), original_id: est.id };
    const { error } = await supabase.from('archive-est').insert(archiveData);
    if (error) return console.error(error);

    await supabase.from('estimates').delete().eq('id', id);
    showMessage('Document archived successfully');
    refreshSavedList();
  };

  const exportData = async () => {
    if (!user || !supabase) return;

    let csv = 'Type,InvoiceNumber,JobName,Date,Address,City,ZipCode,GrandTotal,PhotoUrls,VideoUrls\n';

    if (exportOptions.estimates || exportOptions.invoices) {
      const { data: docs } = await supabase.from('estimates').select('*').eq('user_id', user.id);
      (docs || []).forEach(doc => {
        if ((exportOptions.estimates && (doc.documentType === 'estimate' || doc.invoiceNumber?.startsWith('EST'))) ||
            (exportOptions.invoices && (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')))) {
          const total = doc.items ? doc.items.reduce((sum: number, item: any) => sum + (item.total || 0), 0) : 0;
          csv += `"${doc.documentType || 'estimate'}","${doc.invoiceNumber || ''}","${doc.jobName || ''}","${doc.date || ''}","${doc.address || ''}","${doc.city || ''}","${doc.zipCode || ''}",${total},"${(doc.photoUrls || []).join('; ')}","${(doc.videoUrls || []).join('; ')}"\n`;
        }
      });
    }

    if (exportOptions.archives) {
      const { data: archives } = await supabase.from('archive-est').select('*').eq('user_id', user.id);
      (archives || []).forEach(arch => {
        const total = arch.items ? arch.items.reduce((sum: number, item: any) => sum + (item.total || 0), 0) : 0;
        csv += `"archive","${arch.invoiceNumber || ''}","${arch.jobName || ''}","${arch.date || ''}","${arch.address || ''}","${arch.city || ''}","${arch.zipCode || ''}",${total},"${(arch.photoUrls || []).join('; ')}","${(arch.videoUrls || []).join('; ')}"\n`;
      });
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EstimateAce_Export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showMessage('✅ Selected data exported as CSV');
  };

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSave = () => {
    if (!profile.autoSaveEnabled) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveToDB, 800);
  };

  useEffect(() => {
    if (view === 'editor') debouncedSave();
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod, view, receiptDetails]);

  useEffect(() => {
    const saved = localStorage.getItem('quickLines');
    if (saved) setQuickLines(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (view === 'estimatesList' || view === 'invoicesList') refreshSavedList();
    if (view === 'archivesView') refreshArchivesList();
  }, [view]);

  // Dashboard calculations (only used on dashboard view)
  const estimatesCount = savedEstimatesList.filter(est => 
    est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST')
  ).length;

  const outstandingInvoices = savedEstimatesList.filter(est => 
    (est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')) && 
    est.paymentStatus === 'pending'
  );

  const calculateGrandTotal = (doc: any): number => {
    if (!doc || !doc.items) return 0;
    const itemsTotal = doc.items.reduce((sum: number, item: any) => {
      return sum + (item.total || (item.qty || 0) * (item.price || 0));
    }, 0);
    const laborAmountDoc = doc.laborAmount ?? 
      (doc.useHourlyLabor ? (doc.laborHours || 0) * (doc.laborRate || 0) : (doc.laborFixedAmount || 0));
    const subtotal = itemsTotal + laborAmountDoc;
    const docTaxRate = doc.taxRate ?? (taxRates[doc.state?.toUpperCase() || ''] || 7);
    const taxAmountDoc = subtotal * (docTaxRate / 100);
    return subtotal + taxAmountDoc;
  };

  const totalOutstanding = outstandingInvoices.reduce((sum, inv) => sum + calculateGrandTotal(inv), 0);

  const currentYear = new Date().getFullYear();
  const salesYTD = savedEstimatesList
    .filter(doc => {
      if (!doc.date) return false;
      const docDate = new Date(doc.date);
      if (isNaN(docDate.getTime())) return false;
      return docDate.getFullYear() === currentYear &&
             (doc.documentType === 'invoice' || doc.invoiceNumber?.startsWith('INV')) &&
             doc.paymentStatus === 'paid';
    })
    .reduce((sum, doc) => sum + calculateGrandTotal(doc), 0);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4]">
        <Card className="w-full max-w-md p-8">
          <h1 className="text-4xl font-bold text-center mb-8 text-[#1e293b]">EstimateAce</h1>
          <Input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="mb-3" />
          <Input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="mb-6" />
          <div className="flex gap-3">
            <Button onClick={login} className="flex-1">Login</Button>
            <Button onClick={signup} variant="outline" className="flex-1">Sign Up</Button>
          </div>
        </Card>
      </div>
    );
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

              {/* 1. Total Estimates Written (Not Archived) */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    📋 Total Estimates Written (Not Archived)
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-3/4">Metric</TableHead>
                        <TableHead className="text-right">Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">Active Estimates</TableCell>
                        <TableCell className="text-right text-4xl font-bold text-[#10b981]">
                          {estimatesCount}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* 2. All Outstanding Invoices */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    💰 All Outstanding Invoices
                  </h3>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice #</TableHead>
                          <TableHead>Job Name</TableHead>
                          <TableHead className="text-right">Amount Due</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {outstandingInvoices.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center py-8 text-gray-500">
                              No outstanding invoices
                            </TableCell>
                          </TableRow>
                        ) : (
                          outstandingInvoices.map((inv) => (
                            <TableRow key={inv.id}>
                              <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                              <TableCell>{inv.jobName || 'Untitled'}</TableCell>
                              <TableCell className="text-right font-semibold">
                                ${calculateGrandTotal(inv).toFixed(2)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {outstandingInvoices.length > 0 && (
                    <div className="mt-6 flex justify-end items-baseline gap-2 text-xl">
                      <span className="text-gray-600">Total Outstanding:</span>
                      <span className="font-bold text-amber-600">${totalOutstanding.toFixed(2)}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 3. Total Sales Year to Date */}
              <Card>
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-4 flex items-center gap-2">
                    📈 Total Sales Year to Date
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-3/4">Period</TableHead>
                        <TableHead className="text-right">Sales</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">
                          {currentYear} (Year to Date)
                        </TableCell>
                        <TableCell className="text-right text-4xl font-bold text-[#10b981]">
                          ${salesYTD.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          )}

          {view === 'estimatesList' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-6">All Estimates</h2>
              <div className="space-y-4">
                {savedEstimatesList.filter(est => est.documentType === 'estimate' || est.invoiceNumber?.startsWith('EST')).map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div>
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                    </div>
                    <div className="flex gap-3">
                      <Button size="sm" onClick={() => { loadSelectedEstimate(est); setView('editor'); }}>Open</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>Archive</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'invoicesList' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-6">All Invoices</h2>
              <div className="space-y-4">
                {savedEstimatesList.filter(est => est.documentType === 'invoice' || est.invoiceNumber?.startsWith('INV')).map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div className="flex-1">
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • {est.date}</div>
                    </div>
                    <div className="flex items-center gap-4">
                      {est.paymentStatus === 'paid' && <span className="px-3 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full">Paid</span>}
                      <Button size="sm" onClick={() => { loadSelectedEstimate(est); setView('editor'); }}>Open</Button>
                      <Button size="sm" variant="outline" onClick={() => archiveEstimate(est.id)}>Archive</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'editor' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>

              <div className="flex justify-between items-start mb-8">
                <div>
                  <h1 className="text-5xl font-bold text-[#1e293b]">{profile.company || 'Your Company'}</h1>
                  <p className="text-xl text-gray-600">{profile.slogan || 'Professional Estimation & Invoicing'}</p>
                  {profile.phone && <p className="text-lg text-gray-600 mt-1">📞 {profile.phone}</p>}
                  {profile.email && <p className="text-lg text-gray-600">✉️ {profile.email}</p>}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">Document #</div>
                  <div className="text-4xl font-mono font-bold text-[#10b981]">{invoiceNumber}</div>
                  <div className="text-sm text-gray-500 mt-1">Date: {date}</div>
                </div>
              </div>

              <Card className="mb-8">
                <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold mb-1">Job Name</label>
                    <Input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="Job name" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Address</label>
                    <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Street address" />
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div><label className="block text-sm font-semibold mb-1">City</label><Input value={city} onChange={e => setCity(e.target.value)} /></div>
                    <div><label className="block text-sm font-semibold mb-1">State</label><Input value={state} onChange={e => setState(e.target.value)} placeholder="CA" /></div>
                    <div><label className="block text-sm font-semibold mb-1">Zip Code</label><Input value={zipCode} onChange={e => setZipCode(e.target.value)} /></div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Phone Numbers</label>
                    {phones.map((phone, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={phone} onChange={e => updatePhone(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removePhone(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addPhone}>+ Add Phone</Button>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Email Addresses</label>
                    {emails.map((em, i) => (
                      <div key={i} className="flex gap-2 mb-2">
                        <Input value={em} onChange={e => updateEmail(i, e.target.value)} />
                        <Button variant="outline" size="sm" onClick={() => removeEmail(i)}>×</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={addEmail}>+ Add Email</Button>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-3 mb-8">
                <Button onClick={addRow} variant="outline">+ Add Line Item</Button>
                <Button onClick={openQuickLinesModal} variant="outline">📌 Quick Lines</Button>
              </div>

              <Card className="mb-8">
                <div className="overflow-x-auto">
                  <Table className="min-w-[800px]">
                    <TableHeader>
                      <TableRow className="bg-[#1e293b]">
                        <TableHead className="text-white w-1/2 min-w-[320px]">Description</TableHead>
                        <TableHead className="text-white text-right w-20">Qty</TableHead>
                        <TableHead className="text-white text-right w-20">Unit</TableHead>
                        <TableHead className="text-white text-right w-24">Price</TableHead>
                        <TableHead className="text-white text-right w-28">Total</TableHead>
                        <TableHead className="text-white w-16"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <Textarea 
                              value={item.description} 
                              onChange={e => updateItem(item.id, 'description', e.target.value)} 
                              rows={5}
                              className="resize-y min-h-[120px]"
                            />
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number" 
                              value={item.qty} 
                              onChange={e => updateItem(item.id, 'qty', parseFloat(e.target.value) || 0)} 
                              className="text-right" 
                            />
                          </TableCell>
                          <TableCell>
                            <Input 
                              value={item.unit} 
                              onChange={e => updateItem(item.id, 'unit', e.target.value)} 
                            />
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number" 
                              value={item.price} 
                              onChange={e => updateItem(item.id, 'price', parseFloat(e.target.value) || 0)} 
                              className="text-right" 
                            />
                          </TableCell>
                          <TableCell className="text-right font-medium">${(item.total || 0).toFixed(2)}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button size="sm" variant="outline" onClick={() => saveAsQuickLine(item)}>💾</Button>
                              <Button size="sm" variant="destructive" onClick={() => removeRow(item.id)}>×</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="p-6 bg-white border-t">
                  <div className="flex justify-end text-2xl font-semibold mb-2">
                    Taxes ({state || '—'} {taxRate}%): <span className="text-[#14b8a6] ml-4">${taxAmount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-end text-4xl font-bold">
                    Grand Total: <span className="text-[#10b981] ml-4">${grandTotal.toFixed(2)}</span>
                  </div>
                </div>
              </Card>

              <div className="flex flex-wrap gap-3 mb-8">
                <Button onClick={saveNamedEstimate} className="bg-[#1e293b]">💾 Save Estimate</Button>
                <Button onClick={printDocument} className="bg-[#3b82f6]">🖨️ Print/Preview</Button>
                <Button onClick={openSendPreview} className="bg-[#8b5cf6]">✉️ Send Estimate</Button>
                <Button onClick={convertToInvoice} className="bg-[#f59e0b]">📄 Convert to Invoice</Button>
              </div>

              <div className="flex gap-3 mb-8">
                <Button onClick={() => document.getElementById('photo-camera')?.click()} className="flex-1">📸 Take Photo</Button>
                <Button onClick={() => document.getElementById('video-camera')?.click()} className="flex-1">🎥 Record Video</Button>
              </div>

              <input id="photo-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'photo')} className="hidden" />
              <input id="video-camera" type="file" accept="video/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'video')} className="hidden" />

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">📸 Photos ({photoUrls.length})</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {photoUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('photo', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">🎥 Videos ({videoUrls.length})</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {videoUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <video src={url} controls className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('video', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-4">📄 Receipts ({receiptUrls.length})</h3>
                  <Button onClick={() => document.getElementById('receipts-camera')?.click()} className="mb-4">
                    📄 Scan / Take Photo of Receipt
                  </Button>
                  <Button onClick={() => setIsLaborModalOpen(true)} className="mb-4 bg-[#14b8a6]">
                    💼 Labor
                  </Button>
                  <input id="receipts-camera" type="file" accept="image/*" capture="environment" multiple onChange={e => handleMediaUpload(e.target.files, 'receipt')} className="hidden" />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {receiptUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-full h-40 object-cover rounded-lg border" />
                        <button onClick={() => removeMedia('receipt', i)} className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition">✕</button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-8">
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold mb-3">Terms & Conditions</h3>
                  <Textarea value={terms} onChange={e => setTerms(e.target.value)} rows={6} />
                </CardContent>
              </Card>

              <div id="print-document" className="max-w-4xl mx-auto bg-white p-10 shadow-2xl hidden print:block">
                <h1 className="text-4xl font-bold text-center mb-8">{profile.company || 'Your Company'}</h1>
                {(profile.phone || profile.email) && (
                  <p className="text-center text-xl text-gray-600 mb-8">
                    {profile.phone && `📞 ${profile.phone}`}{profile.phone && profile.email && ' | '}{profile.email && `✉️ ${profile.email}`}
                  </p>
                )}
                <div className="flex justify-between mb-8">
                  <div>
                    <strong>{documentType.toUpperCase()} # {invoiceNumber}</strong><br />
                    Date: {date}<br />
                    Job: {jobName}
                  </div>
                  <div className="text-right">
                    <strong>Bill To:</strong><br />
                    {address}<br />
                    {city}, {state} {zipCode}
                  </div>
                </div>
                <table className="w-full border-collapse mb-8">
                  <thead>
                    <tr className="border-b-2 border-gray-800">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">Price</th>
                      <th className="text-right py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-3">{item.description}</td>
                        <td className="py-3 text-right">{item.qty}</td>
                        <td className="py-3 text-right">${item.price.toFixed(2)}</td>
                        <td className="py-3 text-right">${item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {laborAmount > 0 && (
                  <div className="text-right text-2xl font-semibold text-[#14b8a6]">Labor: ${laborAmount.toFixed(2)}</div>
                )}
                <div className="text-right text-2xl font-semibold text-[#14b8a6]">Taxes ({state || '—'} {taxRate}%): ${taxAmount.toFixed(2)}</div>
                <div className="text-right text-4xl font-bold">Total: ${grandTotal.toFixed(2)}</div>

                {profile.disclosure && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Disclosure / Notes</h3>
                    <div className="text-gray-700 leading-relaxed whitespace-pre-wrap border rounded-xl p-6 bg-gray-50">
                      {profile.disclosure}
                    </div>
                  </div>
                )}

                <div className="mt-12 text-center border-2 border-dashed border-[#10b981] rounded-3xl p-8">
                  <div className="text-4xl font-bold text-[#10b981]">✅ Approved</div>
                  <div className="mt-4 text-xl">
                    Deposit due: <span className="font-semibold">${(grandTotal * (profile.depositPercentage || 0) / 100).toFixed(2)}</span> 
                    <span className="text-sm text-gray-500 ml-2">({profile.depositPercentage || 0}% of total)</span>
                  </div>
                </div>

                {photoUrls.length > 0 && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Attached Photos</h3>
                    <div className="grid grid-cols-2 gap-6">
                      {photoUrls.map((url, i) => (
                        <img key={i} src={url} alt={`Photo ${i + 1}`} className="w-full border rounded-xl shadow-sm max-h-64 object-contain" />
                      ))}
                    </div>
                  </div>
                )}

                {profile.certificateUrl && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Certificate of Insurance</h3>
                    <img src={profile.certificateUrl} alt="Certificate of Insurance" className="max-h-96 mx-auto border rounded-lg shadow" />
                  </div>
                )}
              </div>
            </div>
          )}

          {view === 'profileView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-8">Company Profile</h2>

              <Card className="mb-8">
                <CardContent className="p-8 space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-semibold mb-2">Company Name</label>
                      <Input value={profile.company} onChange={e => setProfile({...profile, company: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Slogan</label>
                      <Input value={profile.slogan} onChange={e => setProfile({...profile, slogan: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Phone</label>
                      <Input value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2">Email</label>
                      <Input value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold mb-2">Address</label>
                      <Input value={profile.address} onChange={e => setProfile({...profile, address: e.target.value})} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">Quick Save (Auto-save)</p>
                      <p className="text-sm text-gray-500">Automatically save changes while editing</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={profile.autoSaveEnabled} 
                        onChange={(e) => setProfile(prev => ({ ...prev, autoSaveEnabled: e.target.checked }))}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                    </label>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-2">Disclosure / Notes</label>
                    <Textarea 
                      value={profile.disclosure} 
                      onChange={e => setProfile({...profile, disclosure: e.target.value})} 
                      rows={4}
                      placeholder="Enter any disclosure text here..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-2">Default Deposit Percentage (%) of total bill</label>
                    <Input 
                      type="number" 
                      value={profile.depositPercentage || 0} 
                      onChange={e => setProfile({...profile, depositPercentage: parseFloat(e.target.value) || 0})}
                      placeholder="10"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold mb-2">Certificate of Insurance</label>
                    <input 
                      type="file" 
                      accept=".pdf,image/*" 
                      onChange={handleCertificateUpload}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-[#10b981] file:text-white hover:file:bg-[#0ea16b]"
                    />
                  </div>

                  {profile.certificateUrl && (
                    <div className="mt-8 border rounded-lg p-6">
                      <h3 className="font-semibold mb-4">Certificate of Insurance</h3>
                      <a href={profile.certificateUrl} target="_blank" rel="noopener noreferrer">
                        <img src={profile.certificateUrl} alt="Certificate of Insurance" className="max-h-96 mx-auto border rounded-lg shadow" />
                      </a>
                      <p className="text-xs text-gray-500 mt-2 text-center">Click image to open full size</p>
                    </div>
                  )}

                  <div className="border-t pt-8">
                    <h3 className="font-semibold mb-4">Teammates</h3>
                    <div className="flex gap-2 mb-6">
                      <Input placeholder="teammate@email.com" id="teammate-email" className="flex-1" />
                      <Button onClick={() => {
                        const input = document.getElementById('teammate-email') as HTMLInputElement;
                        if (!input.value) return;
                        const newTeammate = { email: input.value.trim(), role: 'limited' as 'full' | 'limited' };
                        setProfile(prev => ({ ...prev, teammates: [...(prev.teammates || []), newTeammate] }));
                        input.value = '';
                      }}>Add</Button>
                    </div>
                    <div className="space-y-3">
                      {profile.teammates && profile.teammates.map((tm, index) => (
                        <div key={index} className="flex items-center justify-between border p-4 rounded-lg">
                          <div className="font-medium">{tm.email}</div>
                          <div className="flex items-center gap-6">
                            <div className="flex items-center gap-2">
                              <span className="text-sm">Full</span>
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" checked={tm.role === 'full'} onChange={() => {
                                  const updated = [...profile.teammates];
                                  updated[index].role = updated[index].role === 'full' ? 'limited' : 'full';
                                  setProfile(prev => ({ ...prev, teammates: updated }));
                                }} className="sr-only peer" />
                                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#10b981] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#10b981]"></div>
                              </label>
                              <span className="text-sm">Limited</span>
                            </div>
                            <Button variant="destructive" size="sm" onClick={() => {
                              const updated = profile.teammates.filter((_, i) => i !== index);
                              setProfile(prev => ({ ...prev, teammates: updated }));
                            }}>Remove</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t pt-8">
                    <h3 className="font-semibold mb-4">Export Data</h3>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={exportOptions.estimates} onChange={e => setExportOptions(prev => ({...prev, estimates: e.target.checked}))} />
                        Estimates
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={exportOptions.invoices} onChange={e => setExportOptions(prev => ({...prev, invoices: e.target.checked}))} />
                        Invoices
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={exportOptions.archives} onChange={e => setExportOptions(prev => ({...prev, archives: e.target.checked}))} />
                        Archives
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={exportOptions.photos} onChange={e => setExportOptions(prev => ({...prev, photos: e.target.checked}))} />
                        Photos
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={exportOptions.videos} onChange={e => setExportOptions(prev => ({...prev, videos: e.target.checked}))} />
                        Videos
                      </label>
                    </div>
                    <Button onClick={exportData} className="w-full bg-[#10b981]">Export Selected Data (CSV)</Button>
                  </div>

                  <Button onClick={saveProfile} className="w-full bg-[#10b981]">Save Profile</Button>
                </CardContent>
              </Card>
            </div>
          )}

          {view === 'reportsView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-8">📊 Professional Reports</h2>

              <Card className="max-w-2xl mx-auto">
                <CardContent className="p-8">
                  <label className="block text-sm font-semibold mb-3">Select Job / Estimate with Deposit Paid</label>
                  <select 
                    className="w-full border rounded-xl p-4 text-lg"
                    onChange={e => {
                      const selected = savedEstimatesList.find(est => est.id === e.target.value);
                      setSelectedReportJob(selected || null);
                    }}
                  >
                    <option value="">— Choose a paid deposit job —</option>
                    {savedEstimatesList
                      .filter(est => (est.amountPaid || 0) > 0)
                      .map(est => (
                        <option key={est.id} value={est.id}>
                          {est.jobName || 'Untitled'} — {est.invoiceNumber} (Deposit: ${(est.amountPaid || 0).toFixed(2)})
                        </option>
                      ))}
                  </select>

                  {selectedReportJob && (
                    <div className="mt-10 space-y-8">
                      <div className="grid grid-cols-2 gap-6">
                        <div className="bg-white border rounded-2xl p-6 text-center">
                          <div className="text-sm text-gray-500">Total Receipts</div>
                          <div className="text-5xl font-bold text-[#10b981] mt-2">
                            ${(selectedReportJob.receiptDetails || []).reduce((sum: number, r: any) => sum + (r.amount || 0), 0).toFixed(2)}
                          </div>
                        </div>
                        <div className="bg-white border rounded-2xl p-6 text-center">
                          <div className="text-sm text-gray-500">Labor Cost</div>
                          <div className="text-5xl font-bold text-[#14b8a6] mt-2">
                            ${selectedReportJob.laborAmount ? selectedReportJob.laborAmount.toFixed(2) : '0.00'}
                          </div>
                        </div>
                      </div>

                      <div className="bg-white border-2 border-[#1e293b] rounded-3xl p-8">
                        <div className="flex justify-between items-baseline">
                          <div>
                            <div className="text-2xl font-semibold">Gross Total Charged</div>
                            <div className="text-6xl font-bold text-[#1e293b]">${(selectedReportJob.grandTotal || 0).toFixed(2)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm text-gray-500">Deposit Paid</div>
                            <div className="text-5xl font-bold text-[#10b981]">${(selectedReportJob.amountPaid || 0).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>

                      <div className="text-center text-4xl font-bold text-[#10b981]">
                        Net Profit: ${(
                          (selectedReportJob.grandTotal || 0) - 
                          (selectedReportJob.receiptDetails || []).reduce((sum: number, r: any) => sum + (r.amount || 0), 0) - 
                          (selectedReportJob.laborAmount || 0)
                        ).toFixed(2)}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* NEW TAB + SCROLL-DOWN MENU FOR ARCHIVES */}
              <div className="max-w-2xl mx-auto mt-10">
                <Button 
                  onClick={() => refreshArchivesList()}
                  className="mb-4 w-full bg-[#1e293b] text-white"
                >
                  📂 Retrieve Archives
                </Button>
                <select 
                  className="w-full border rounded-xl p-4 text-lg"
                  onChange={e => {
                    const selectedArchive = archivesList.find(arch => arch.id === e.target.value);
                    if (selectedArchive) {
                      showMessage(`📂 Opened archive: ${selectedArchive.jobName || 'Untitled'} — ${selectedArchive.invoiceNumber}`);
                    }
                  }}
                >
                  <option value="">— Scroll to select an archived item —</option>
                  {archivesList.map(arch => (
                    <option key={arch.id} value={arch.id}>
                      {arch.jobName || 'Untitled'} — {arch.invoiceNumber} (Archived: {new Date(arch.archived_at).toLocaleDateString()})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {view === 'archivesView' && (
            <div>
              <Button variant="outline" onClick={goToDashboard} className="mb-6">← Back to Dashboard</Button>
              <h2 className="text-3xl font-semibold mb-6">Archived Documents</h2>
              <div className="space-y-4">
                {archivesList.map((est) => (
                  <div key={est.id} className="flex justify-between items-center border p-4 rounded-lg bg-white">
                    <div>
                      <div className="font-medium">{est.jobName || 'Untitled'}</div>
                      <div className="text-sm text-gray-500">{est.invoiceNumber} • Archived: {new Date(est.archived_at).toLocaleDateString()}</div>
                    </div>
                    <div className="flex gap-3">
                      <Button size="sm" onClick={() => { loadSelectedEstimate(est); setView('editor'); }}>Open</Button>
                      <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'sendPreview' && (
            <div className="max-w-4xl mx-auto">
              <Button variant="outline" onClick={() => setView('editor')} className="mb-6">← Back to Editor</Button>
              <h2 className="text-3xl font-semibold mb-6">
                {documentType === 'invoice' ? '📄 Invoice Preview & Final Payment' : 'Preview of what will be sent'}
              </h2>

              <Button 
                onClick={() => { 
                  setSelectedEmailsForSend([...emails]); 
                  setSelectedPhonesForSend([...phones]); 
                  setIsSendModalOpen(true); 
                }} 
                className="mb-6 bg-[#f97316] text-white px-8 py-3 text-lg">
                📧 Choose Recipients & Send
              </Button>

              <div className="bg-white p-10 shadow-2xl rounded-2xl border mb-8">
                <h1 className="text-4xl font-bold text-center mb-8">{profile.company || 'Your Company'}</h1>
                {(profile.phone || profile.email) && (
                  <p className="text-center text-xl text-gray-600 mb-8">
                    {profile.phone && `📞 ${profile.phone}`}{profile.phone && profile.email && ' | '}{profile.email && `✉️ ${profile.email}`}
                  </p>
                )}
                <div className="flex justify-between mb-8">
                  <div>
                    <strong>{documentType.toUpperCase()} # {invoiceNumber}</strong><br />
                    Date: {date}<br />
                    Job: {jobName}
                  </div>
                  <div className="text-right">
                    <strong>Bill To:</strong><br />
                    {address}<br />
                    {city}, {state} {zipCode}
                  </div>
                </div>
                <table className="w-full border-collapse mb-8">
                  <thead>
                    <tr className="border-b-2 border-gray-800">
                      <th className="text-left py-2">Description</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">Price</th>
                      <th className="text-right py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => (
                      <tr key={i} className="border-b">
                        <td className="py-3">{item.description}</td>
                        <td className="py-3 text-right">{item.qty}</td>
                        <td className="py-3 text-right">${item.price.toFixed(2)}</td>
                        <td className="py-3 text-right">${item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-right text-3xl font-bold">Total: ${grandTotal.toFixed(2)}</div>

                {profile.disclosure && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Disclosure / Notes</h3>
                    <div className="text-gray-700 leading-relaxed whitespace-pre-wrap border rounded-xl p-6 bg-gray-50">
                      {profile.disclosure}
                    </div>
                  </div>
                )}

                {documentType !== 'invoice' && (
                  <div className="mt-12 text-center">
                    <Button 
                      onClick={() => {
                        const deposit = grandTotal * (profile.depositPercentage || 0) / 100;
                        if (confirm(`✅ Estimate Approved!\n\nDeposit due: $${deposit.toFixed(2)} (${profile.depositPercentage || 0}% of total)\n\nWould you like to pay the deposit now?`)) {
                          alert(`💳 Deposit of $${deposit.toFixed(2)} has been paid!\n\nThank you – the estimate is now fully approved and paid.`);
                        }
                      }}
                      className="w-full text-3xl py-8 bg-[#10b981] hover:bg-[#0ea16b] text-white font-semibold rounded-3xl shadow-lg"
                    >
                      Approved
                    </Button>
                  </div>
                )}

                {documentType === 'invoice' && (
                  <div className="mt-12 p-8 border-4 border-dashed border-[#f59e0b] rounded-3xl bg-amber-50">
                    <h3 className="text-3xl font-bold text-center text-[#f59e0b]">💰 Invoice Payment Section</h3>
                    <p className="text-center text-xl mt-3">
                      Deposit paid on estimate: <strong>{profile.depositPercentage}%</strong><br />
                      Remainder due: <strong>{100 - (profile.depositPercentage || 0)}%</strong> = <span className="font-bold text-2xl"> ${(grandTotal * (100 - (profile.depositPercentage || 0)) / 100).toFixed(2)}</span>
                    </p>
                    <Button 
                      onClick={() => {
                        const remainder = grandTotal * (100 - (profile.depositPercentage || 0)) / 100;
                        if (confirm(`Pay the remaining $${remainder.toFixed(2)} now?\n\nThis will mark the invoice as fully paid.`)) {
                          alert(`✅ Payment of $${remainder.toFixed(2)} received!\n\nInvoice is now 100% PAID and marked complete.\nThank you!`);
                          setPaymentStatus('paid');
                          setAmountPaid(grandTotal);
                          showMessage('Invoice marked PAID and saved');
                        }
                      }}
                      className="w-full mt-6 py-8 text-2xl font-bold bg-[#f59e0b] hover:bg-orange-600 text-white rounded-3xl">
                      Pay Remainder Now (${(grandTotal * (100 - (profile.depositPercentage || 0)) / 100).toFixed(2)})
                    </Button>
                    <p className="text-center text-xs text-gray-500 mt-3">Clicking this completes the invoice conversion</p>
                  </div>
                )}

                {photoUrls.length > 0 && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Attached Photos</h3>
                    <div className="grid grid-cols-2 gap-6">
                      {photoUrls.map((url, i) => (
                        <img key={i} src={url} alt={`Photo ${i + 1}`} className="w-full border rounded-xl shadow-sm max-h-64 object-contain" />
                      ))}
                    </div>
                  </div>
                )}

                {profile.certificateUrl && (
                  <div className="mt-12">
                    <h3 className="text-2xl font-semibold mb-6 border-b pb-3">Certificate of Insurance</h3>
                    <img src={profile.certificateUrl} alt="Certificate of Insurance" className="max-h-96 mx-auto border rounded-lg shadow" />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Navigation */}
        <div className="bg-white border-t shadow-inner flex items-center justify-around py-2 px-1 text-xs">
          <button onClick={goToDashboard} className={`flex flex-col items-center flex-1 py-1 ${view === 'dashboard' ? 'text-[#10b981]' : 'text-gray-500'}`}>
            <span className="text-3xl mb-0.5">📊</span>
            <span>Dashboard</span>
          </button>
          <button onClick={() => setView('estimatesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📋</span>
            <span>Estimate</span>
          </button>
          <button onClick={() => setView('invoicesList')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">💰</span>
            <span>Invoice</span>
          </button>
          <button onClick={() => openNewDocument('estimate')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📄</span>
            <span>New Estimate</span>
          </button>
          <button onClick={() => setView('reportsView')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📊</span>
            <span>Reports</span>
          </button>
          <button onClick={openCalendarModal} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">📅</span>
            <span>Calendar</span>
          </button>
          <button onClick={() => setView('profileView')} className="flex flex-col items-center flex-1 py-1 text-gray-500">
            <span className="text-3xl mb-0.5">👤</span>
            <span>Profile</span>
          </button>
        </div>
      </div>

      {/* Load Modal */}
      <Dialog open={isLoadModalOpen} onOpenChange={setIsLoadModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Saved Documents</DialogTitle></DialogHeader>
          <div className="max-h-96 overflow-auto">
            {savedEstimatesList.map(est => (
              <div key={est.id} className="flex justify-between items-center p-4 border-b">
                <div>
                  <div className="font-semibold">{est.jobName || 'Untitled'} — {est.invoiceNumber}</div>
                  <div className="text-xs text-gray-500">{est.date}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => { loadSelectedEstimate(est); setIsLoadModalOpen(false); setView('editor'); }}>Load</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteSelectedEstimate(est.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Send Recipients Popup */}
      <Dialog open={isSendModalOpen} onOpenChange={setIsSendModalOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>📧 Choose Recipients for this Estimate</DialogTitle></DialogHeader>
          <div className="space-y-6">
            <div>
              <h4 className="font-semibold mb-2">Select Emails</h4>
              {emails.map((em, i) => (
                <label key={i} className="flex items-center gap-2 mb-1">
                  <input 
                    type="checkbox" 
                    checked={selectedEmailsForSend.includes(em)}
                    onChange={() => {
                      setSelectedEmailsForSend(prev => prev.includes(em) ? prev.filter(e => e !== em) : [...prev, em]);
                    }}
                  />
                  {em || '(empty)'}
                </label>
              ))}
            </div>
            <div>
              <h4 className="font-semibold mb-2">Select Phone Numbers</h4>
              {phones.map((ph, i) => (
                <label key={i} className="flex items-center gap-2 mb-1">
                  <input 
                    type="checkbox" 
                    checked={selectedPhonesForSend.includes(ph)}
                    onChange={() => {
                      setSelectedPhonesForSend(prev => prev.includes(ph) ? prev.filter(p => p !== ph) : [...prev, ph]);
                    }}
                  />
                  {ph || '(empty)'}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSendModalOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              showMessage(`✅ Estimate sent to selected recipients!\nEmails: ${selectedEmailsForSend.join(', ') || 'none'}\nPhones: ${selectedPhonesForSend.join(', ') || 'none'}`);
              setIsSendModalOpen(false);
            }} className="bg-[#10b981]">Send Now</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Labor Popup */}
      <Dialog open={isLaborModalOpen} onOpenChange={setIsLaborModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>💼 Add Labor to Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={useHourlyLabor} onChange={() => setUseHourlyLabor(true)} />
                Hourly
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={!useHourlyLabor} onChange={() => setUseHourlyLabor(false)} />
                Fixed Amount
              </label>
            </div>

            {useHourlyLabor ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-1">Hours</label>
                  <Input type="number" value={laborHours} onChange={e => setLaborHours(parseFloat(e.target.value) || 0)} />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-1">Hourly Rate</label>
                  <Input type="number" value={laborRate} onChange={e => setLaborRate(parseFloat(e.target.value) || 0)} />
                </div>
                <div className="col-span-2 text-right text-xl font-semibold">
                  Labor Total: <span className="text-[#14b8a6]">${(laborHours * laborRate).toFixed(2)}</span>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-semibold mb-1">Fixed Labor Amount</label>
                <Input type="number" value={laborFixedAmount} onChange={e => setLaborFixedAmount(parseFloat(e.target.value) || 0)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsLaborModalOpen(false)}>Cancel</Button>
            <Button onClick={() => { setIsLaborModalOpen(false); showMessage(`✅ Labor of $${laborAmount.toFixed(2)} added`); }} className="bg-[#14b8a6]">Save Labor</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Extraction Modal */}
      <Dialog open={isReceiptExtractModalOpen} onOpenChange={setIsReceiptExtractModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>📄 Extract Receipt Information</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div>
              <label className="block text-sm font-semibold mb-1">Receipt Date</label>
              <Input type="date" value={tempReceiptData.date} onChange={e => setTempReceiptData({...tempReceiptData, date: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Vendor / Store</label>
              <Input value={tempReceiptData.vendor} onChange={e => setTempReceiptData({...tempReceiptData, vendor: e.target.value})} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Total Amount</label>
              <Input type="number" value={tempReceiptData.amount} onChange={e => setTempReceiptData({...tempReceiptData, amount: parseFloat(e.target.value) || 0})} />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Notes / Items</label>
              <Textarea value={tempReceiptData.notes} onChange={e => setTempReceiptData({...tempReceiptData, notes: e.target.value})} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReceiptExtractModalOpen(false)}>Cancel</Button>
            <Button onClick={saveReceiptExtraction} className="bg-[#10b981]">Save to Database</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Lines Modal */}
      <Dialog open={isQuickLinesModalOpen} onOpenChange={setIsQuickLinesModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>📌 Saved Quick Lines</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-auto py-2">
            {quickLines.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                No quick lines saved yet.<br />
                Click the 💾 icon next to any line item to save one.
              </div>
            ) : (
              <div className="space-y-3">
                {quickLines.map((quick) => (
                  <div key={quick.id} className="flex justify-between items-center border rounded-xl p-4 bg-white">
                    <div className="flex-1">
                      <div className="font-medium text-lg">{quick.description}</div>
                      <div className="text-sm text-gray-500 mt-1">
                        {quick.qty} × ${quick.price.toFixed(2)} = ${(quick.qty * quick.price).toFixed(2)}
                        {quick.unit && ` • ${quick.unit}`}
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Button 
                        size="sm" 
                        onClick={() => useQuickLine(quick)}
                        className="bg-[#10b981]"
                      >
                        Use
                      </Button>
                      <Button 
                        size="sm" 
                        variant="destructive"
                        onClick={() => deleteQuickLine(quick.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsQuickLinesModalOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}