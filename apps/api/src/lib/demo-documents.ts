/**
 * Paperwork in the demo company's inbox, as suppliers actually send it. All names and numbers are made up,
 * but they refer to the demo's real records: the open shipment CAIU3390471 (MRN 26GB7F1B36E2A06), purchase
 * order PO-00008 that arrived short, and a rent invoice that was emailed twice.
 */
export const DEMO_DOCUMENTS = [
  {
    filename: "FFS-9214 Felixstowe Freight.txt",
    content: `Felixstowe Freight Services Ltd
Dock Gate 2, Walton Avenue, Felixstowe IP11 3HH
VAT Reg No: GB 193 8475 18    Company No: 05529761

TAX INVOICE

Invoice No: FFS-9214
Invoice Date: 29/10/2026
Due Date: 12/11/2026
Customer: Thames Valley Imports Ltd
Container: CAIU3390471   B/L: COSU6402219870   Vessel: CSCL Saturn 041W

Ocean freight Yantian to Felixstowe 40HC        0%   1,480.00
Terminal handling charges Felixstowe            20%    215.00
Delivery Felixstowe to Reading                  20%    295.00

Subtotal  1,990.00
VAT 20%  102.00
Total due  2,092.00

Payment by BACS to Felixstowe Freight Services Ltd, sort code 20-45-77, account 30981166.`,
  },
  {
    filename: "HCB-5188 Harbour Customs.txt",
    content: `Harbour Customs Brokers Ltd
Customs House, Langer Road, Felixstowe IP11 2BW
VAT No: GB556677830

INVOICE

Invoice No: HCB-5188
Date: 28/10/2026
Due Date: 11/11/2026
Your ref: CAIU3390471
Import entry MRN: 26GB7F1B36E2A06 (CDS, postponed VAT accounting)

Import duty paid on your behalf (deferment)        612.40
Customs clearance and entry fee            20%      95.00

Net  707.40
VAT  19.00
Total  726.40`,
  },
  {
    filename: "GPA-26-0917 commercial invoice.txt",
    content: `Guangzhou Pearl Appliances Co
No. 88 Huangpu East Road, Guangzhou, China

COMMERCIAL INVOICE

Invoice No: GPA-26-0917
Invoice Date: 25/10/2026
Buyer: Thames Valley Imports Ltd
Your PO: PO-00008
Terms: FOB Yantian, payment T/T 30 days, currency USD
Container: CAIU3390471

SCL-DIG-5 Digital kitchen scales 5kg    2400    4.55   10,920.00
BLD-600-SS Jug blender 600W stainless    540   14.10    7,614.00

Total USD  18,534.00
Balance of 360 blenders to follow on next sailing.`,
  },
  {
    filename: "Kennet Estates rent October (resent).txt",
    content: `Kennet Estates Ltd
Abbey House, Abbey Square, Reading RG1 3BE
VAT Registration Number: GB302010449

TAX INVOICE - COPY

Invoice No: KE-RENT-202610
Invoice Date: 01/10/2026
Due Date: 31/10/2026

Warehouse rent Unit 4 Kennet Trade Park, October 2026        2,250.00

Subtotal  2,250.00
VAT 20%  450.00
Total due  2,700.00

Our records show this invoice as unpaid. Please arrange payment.`,
  },
];
