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

  // Real Tax Logic States
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [taxLabor, setTaxLabor] = useState(true);

  // ====================== DYNAMIC ZIP CODE TAX LOOKUP ======================
  const getTaxRateFromZip = (zip: string, fallbackState: string): number => {
    const zipTaxMap: { [key: string]: number } = {
      '33101': 7.0, '33139': 7.0, '90210': 9.5, '10001': 8.875,
      '60601': 10.25, '77001': 8.25, '75201': 8.25, '94102': 8.5,
      '30303': 8.9, '33131': 7.0,
    };
    const cleanZip = zip.trim().replace(/\D/g, '').slice(0, 5);
    if (zipTaxMap[cleanZip]) return zipTaxMap[cleanZip];

    const stateRates: { [key: string]: number } = {
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
    return stateRates[fallbackState.toUpperCase()] || 7;
  };

  const baseTaxRate = getTaxRateFromZip(zipCode, state);

  // Real tax calculation
  const taxableSubtotal = items.reduce((sum, item) => sum + (item.total || 0), 0);
  const taxableLabor = taxLabor ? laborAmount : 0;
  const taxableTotal = taxableSubtotal + taxableLabor;
  const taxAmount = isTaxExempt ? 0 : taxableTotal * (baseTaxRate / 100);
  const grandTotal = taxableSubtotal + laborAmount + taxAmount;

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
      laborHours, laborRate, laborFixedAmount, useHourlyLabor, laborAmount,
      taxRate: baseTaxRate,
      taxAmount,
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
    setIsTaxExempt(est.isTaxExempt || false);
    setTaxLabor(est.taxLabor !== false);
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
    setIsTaxExempt(false);
    setTaxLabor(true);
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

    const appointmentTime = new Date(selectedDateTime).toLocaleString();
    const reminderTime = new Date(new Date(selectedDateTime).getTime() - 24 * 60 * 60 * 1000).toLocaleString();

    showMessage(`✅ Appointment scheduled for ${appointmentTime}\n\n📧 Email & 📱 Text sent to client immediately.\n\n⏰ Reminder text & email will be sent 24 hours before (${reminderTime})`);

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
  }, [jobName, address, city, state, zipCode, phones, emails, date, invoiceNumber, items, terms, profile, documentType, dueDate, paymentStatus, amountPaid, paymentMethod, view, receiptDetails, isTaxExempt, taxLabor]);

  useEffect(() => {
    const saved = localStorage.getItem('quickLines');
    if (saved) setQuickLines(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (view === 'dashboard' || view === 'estimatesList' || view === 'invoicesList') refreshSavedList();
    if (view === 'archivesView') refreshArchivesList();
  }, [view]);

  // Dashboard calculations
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
    const docTaxRate = doc.taxRate ?? 7;
    const docTaxAmount = doc.isTaxExempt ? 0 : (subtotal + (doc.taxLabor !== false ? laborAmountDoc : 0)) * (docTaxRate / 100);
    return subtotal + laborAmountDoc + docTaxAmount;
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
            <div className="space-y-8">
              <h1 className="text-4xl font-bold">Dashboard</h1>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card>
                  <CardContent className="p-6">
                    <div className="text-sm text-gray-500">Total Estimates Written</div>
                    <div className="text-6xl font-bold text-[#10b981]">{estimatesCount}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6">
                    <div className="text-sm text-gray-500">Outstanding Invoices</div>
                    <div className="text-6xl font-bold text-orange-500">{outstandingInvoices.length}</div>
                    <div className="text-sm text-gray-500 mt-2">Total Due: ${totalOutstanding.toFixed(2)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6">
                    <div className="text-sm text-gray-500">Sales YTD</div>
                    <div className="text-6xl font-bold text-[#10b981]">${salesYTD.toFixed(2)}</div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {view === 'estimatesList' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">All Estimates</h1>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Estimate #</TableHead>
                    <TableHead>Job Name</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {savedEstimatesList.filter(e => e.documentType === 'estimate' || e.invoiceNumber?.startsWith('EST')).map(est => (
                    <TableRow key={est.id}>
                      <TableCell>{est.invoiceNumber}</TableCell>
                      <TableCell>{est.jobName}</TableCell>
                      <TableCell>{est.date}</TableCell>
                      <TableCell>
                        <Button size="sm" onClick={() => openExistingDocument(est)}>Open</Button>
                        <Button size="sm" variant="outline" className="ml-2" onClick={() => archiveEstimate(est.id)}>Archive</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {view === 'invoicesList' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">All Invoices</h1>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Job Name</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {savedEstimatesList.filter(e => e.documentType === 'invoice' || e.invoiceNumber?.startsWith('INV')).map(inv => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.invoiceNumber}</TableCell>
                      <TableCell>{inv.jobName}</TableCell>
                      <TableCell>{inv.date}</TableCell>
                      <TableCell>{inv.paymentStatus}</TableCell>
                      <TableCell>
                        <Button size="sm" onClick={() => openExistingDocument(inv)}>Open</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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

                  <div className="md:col-span-2 flex items-center gap-8 pt-4 border-t">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={isTaxExempt} onChange={e => setIsTaxExempt(e.target.checked)} />
                      <span className="font-medium">Tax Exempt</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={taxLabor} onChange={e => setTaxLabor(e.target.checked)} />
                      <span className="font-medium">Tax Labor</span>
                    </label>
                    <div className="ml-auto text-sm text-gray-500">
                      Rate: <span className="font-semibold">{baseTaxRate}%</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Line Items */}
              <Card className="mb-8">
                <CardContent className="p-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-semibold">Line Items</h3>
                    <Button onClick={addRow}>+ Add Row</Button>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Description</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead>Price</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map(item => (
                        <TableRow key={item.id}>
                          <TableCell><Input value={item.description} onChange={e => updateItem(item.id, 'description', e.target.value)} /></TableCell>
                          <TableCell><Input type="number" value={item.qty} onChange={e => updateItem(item.id, 'qty', e.target.value)} /></TableCell>
                          <TableCell><Input value={item.unit} onChange={e => updateItem(item.id, 'unit', e.target.value)} /></TableCell>
                          <TableCell><Input type="number" value={item.price} onChange={e => updateItem(item.id, 'price', e.target.value)} /></TableCell>
                          <TableCell className="font-medium">${(item.total || 0).toFixed(2)}</TableCell>
                          <TableCell><Button variant="destructive" size="sm" onClick={() => removeRow(item.id)}>×</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <div className="flex gap-4 mt-8">
                <Button onClick={saveNamedEstimate} className="flex-1 bg-[#10b981]">Save Estimate</Button>
                <Button onClick={printDocument} variant="outline">Print</Button>
                <Button onClick={convertToInvoice} variant="outline">Convert to Invoice</Button>
              </div>
            </div>
          )}

          {/* REPORTS VIEW - restored with full separation of tax and cost */}
          {view === 'reportsView' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">Reports</h1>
              <Card>
                <CardContent className="p-6">
                  <div className="flex gap-4 mb-6">
                    <Button variant={selectedReportJob ? "default" : "outline"} onClick={() => setSelectedReportJob(null)}>All Jobs</Button>
                    {savedEstimatesList.map(job => (
                      <Button key={job.id} variant={selectedReportJob?.id === job.id ? "default" : "outline"} onClick={() => setSelectedReportJob(job)}>
                        {job.jobName}
                      </Button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <Card>
                      <CardContent className="p-6 text-center">
                        <div className="text-sm text-gray-500">Total Profit (after tax &amp; costs)</div>
                        <div className="text-5xl font-bold text-[#10b981]">${salesYTD.toFixed(2)}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-6 text-center">
                        <div className="text-sm text-gray-500">Tax Collected</div>
                        <div className="text-5xl font-bold text-orange-500">${outstandingInvoices.reduce((sum, inv) => sum + (inv.taxAmount || 0), 0).toFixed(2)}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-6 text-center">
                        <div className="text-sm text-gray-500">Deductible Costs</div>
                        <div className="text-5xl font-bold text-blue-500">${outstandingInvoices.reduce((sum, inv) => sum + (inv.receiptDetails ? inv.receiptDetails.reduce((s: number, r: any) => s + (r.amount || 0), 0) : 0), 0).toFixed(2)}</div>
                      </CardContent>
                    </Card>
                  </div>
                  <Button onClick={exportData} className="w-full mt-8">Export Full Report CSV</Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* PROFILE VIEW - fully restored */}
          {view === 'profileView' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">Company Profile</h1>
              <Card>
                <CardContent className="p-6 space-y-6">
                  <div>
                    <label className="block text-sm font-semibold mb-1">Company Name</label>
                    <Input value={profile.company} onChange={e => setProfile({...profile, company: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Slogan</label>
                    <Input value={profile.slogan} onChange={e => setProfile({...profile, slogan: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Address</label>
                    <Input value={profile.address} onChange={e => setProfile({...profile, address: e.target.value})} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold mb-1">Phone</label>
                      <Input value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Email</label>
                      <Input value={profile.email} onChange={e => setProfile({...profile, email: e.target.value})} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Disclosure Text</label>
                    <Textarea value={profile.disclosure} onChange={e => setProfile({...profile, disclosure: e.target.value})} rows={3} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Deposit Percentage</label>
                    <Input type="number" value={profile.depositPercentage} onChange={e => setProfile({...profile, depositPercentage: parseFloat(e.target.value) || 10})} />
                  </div>
                  <Button onClick={saveProfile} className="w-full bg-[#10b981]">Save Profile</Button>
                </CardContent>
              </Card>
            </div>
          )}

          {view === 'archivesView' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">Archived Documents</h1>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document #</TableHead>
                    <TableHead>Job Name</TableHead>
                    <TableHead>Archived Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {archivesList.map(arch => (
                    <TableRow key={arch.id}>
                      <TableCell>{arch.invoiceNumber}</TableCell>
                      <TableCell>{arch.jobName}</TableCell>
                      <TableCell>{arch.archived_at}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {view === 'sendPreview' && (
            <div>
              <h1 className="text-4xl font-bold mb-6">Send Preview</h1>
              <Button onClick={openSendPreview} className="w-full">Send to Client</Button>
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

      {/* Calendar Modal */}
      <Dialog open={isCalendarModalOpen} onOpenChange={setIsCalendarModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule Appointment</DialogTitle>
          </DialogHeader>
          <select onChange={e => setSelectedEstimateForCalendar(savedEstimatesList.find(est => est.id === e.target.value))} className="w-full p-3 border rounded-xl">
            <option value="">Select an estimate...</option>
            {savedEstimatesList.map(est => <option key={est.id} value={est.id}>{est.invoiceNumber} - {est.jobName}</option>)}
          </select>
          <Input type="datetime-local" value={selectedDateTime} onChange={e => setSelectedDateTime(e.target.value)} className="mt-4" />
          <DialogFooter>
            <Button onClick={scheduleAppointment} className="bg-[#10b981]">Schedule & Send Notifications</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Lines Modal */}
      <Dialog open={isQuickLinesModalOpen} onOpenChange={setIsQuickLinesModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quick Lines</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-auto space-y-4">
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
                  <Button size="sm" onClick={() => useQuickLine(quick)} className="bg-[#10b981]">Use</Button>
                  <Button size="sm" variant="destructive" onClick={() => deleteQuickLine(quick.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsQuickLinesModalOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Modal */}
      <Dialog open={isReceiptExtractModalOpen} onOpenChange={setIsReceiptExtractModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receipt Details</DialogTitle>
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

    </>
  );
}