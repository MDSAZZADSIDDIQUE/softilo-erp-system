import type { ReactNode, SVGProps } from "react";

/**
 * Softilo's two-tone icons, the same family as Shiftly's: 24px grid, 1.75px rounded line work in the
 * current colour, plus a soft tinted fill. `tint` recolours the fill (the active menu item fills it orange).
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number; tint?: string; tintOpacity?: number };
type Fill = { fill: string; fillOpacity: number };

export type SoftiloIcon = (props: IconProps) => ReactNode;

function icon(name: string, draw: (fill: Fill) => ReactNode, defaultOpacity = 0.14) {
  function Icon({ size = 20, tint = "currentColor", tintOpacity = defaultOpacity, strokeWidth = 1.75, style, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ flexShrink: 0, ...style }}
        {...props}
      >
        {draw({ fill: tint, fillOpacity: tintOpacity })}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

const PANEL = "M5 4.5h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z";
const DOCUMENT = "M7 3h7l4.5 4.5v12A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 7 3zM14 3v4.5h4.5";
const RECEIPT = "M5.5 3.5h13v17l-2.2-1.4-2.1 1.4-2.2-1.4-2.2 1.4-2.1-1.4-2.2 1.4z";
const CLIPBOARD_FILL = "M5.8 4.5h12.4a1.3 1.3 0 0 1 1.3 1.3v13.9a1.3 1.3 0 0 1-1.3 1.3H5.8a1.3 1.3 0 0 1-1.3-1.3V5.8a1.3 1.3 0 0 1 1.3-1.3z";
const CLIPBOARD = "M7 4.5H5.8a1.3 1.3 0 0 0-1.3 1.3v13.9a1.3 1.3 0 0 0 1.3 1.3h12.4a1.3 1.3 0 0 0 1.3-1.3V5.8a1.3 1.3 0 0 0-1.3-1.3H17M9.5 3h5a1 1 0 0 1 1 1v1.5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z";
const CALENDAR_HEAD = "M6 5h12a2.5 2.5 0 0 1 2.5 2.5V10h-17V7.5A2.5 2.5 0 0 1 6 5z";
const CALENDAR = "M6 5h12a2.5 2.5 0 0 1 2.5 2.5V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V7.5A2.5 2.5 0 0 1 6 5zM3.5 10h17M8 3v4M16 3v4";
const UMBRELLA_TOP = "M12 4a8.5 8.5 0 0 1 8.5 8.5h-17A8.5 8.5 0 0 1 12 4z";
const WARNING = "M10.3 4.3 2.6 17.7A2 2 0 0 0 4.3 20.7h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z";

/* ---------------------------------------------------------------- the shell */

export const DashboardIcon = icon("DashboardIcon", (f) => (
  <>
    <path d={PANEL} {...f} stroke="none" />
    <path d={`${PANEL}M14 4.5h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM14 12.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM5 16.5h5a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1z`} />
  </>
));

export const MenuIcon = icon("MenuIcon", () => <path d="M4 6.5h16M4 12h16M4 17.5h16" />);

export const SignOutIcon = icon("SignOutIcon", (f) => (
  <>
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" {...f} />
    <path d="M10 8l-4 4 4 4M6 12h10" />
  </>
));

export const InboxIcon = icon("InboxIcon", (f) => (
  <>
    <path d="M3 13h5l1.5 2.5h5L16 13h5v5.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...f} stroke="none" />
    <path d="M3 13h5l1.5 2.5h5L16 13h5M6.2 4.5h11.6a1 1 0 0 1 .9.6L21 13v5.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V13l2.3-7.9a1 1 0 0 1 .9-.6z" />
    <path d="M9 8.5h6M10 11h4" />
  </>
));

export const SettingsIcon = icon("SettingsIcon", (f) => (
  <>
    <path d="M3.5 7H11.5M17 7h3.5M3.5 17H7M12.5 17h8" />
    <circle cx="14.2" cy="7" r="2.7" {...f} />
    <circle cx="9.8" cy="17" r="2.7" {...f} />
  </>
), 0.16);

export const AuditIcon = icon("AuditIcon", (f) => (
  <>
    <circle cx="12.5" cy="12" r="8.5" {...f} stroke="none" />
    <path d="M4 12a8.5 8.5 0 1 0 2.6-6.1L4 8.5M4 4v4.5h4.5M12.5 7.5V12l3 1.8" />
  </>
));

/* ---------------------------------------------------------------- people */

export const CustomersIcon = icon("CustomersIcon", (f) => (
  <>
    <circle cx="9" cy="7.5" r="3.5" {...f} stroke="none" />
    <path d="M9 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5M15.5 4.3a3.5 3.5 0 0 1 0 6.4M17.8 14.8c1.9.7 3.2 2.4 3.7 5.2" />
  </>
));

export const UserCheckIcon = icon("UserCheckIcon", (f) => (
  <>
    <circle cx="10" cy="7.5" r="3.5" {...f} stroke="none" />
    <path d="M10 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3.5 20c.7-3.6 3.3-5.5 6.5-5.5 1.1 0 2.1.2 3 .6M15.5 18.2l2 2 4-4.2" />
  </>
), 0.16);

export const UserPlusIcon = icon("UserPlusIcon", (f) => (
  <>
    <circle cx="10" cy="7.5" r="3.5" {...f} stroke="none" />
    <path d="M10 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3.5 20c.7-3.6 3.3-5.5 6.5-5.5 1.1 0 2.1.2 3 .6M18.5 14.5v6M15.5 17.5h6" />
  </>
), 0.16);

export const UserClockIcon = icon("UserClockIcon", (f) => (
  <>
    <circle cx="9" cy="7.5" r="3.5" {...f} stroke="none" />
    <path d="M9 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20c.7-3.6 3.3-5.5 6.5-5.5.6 0 1.2.1 1.8.2" />
    <circle cx="17" cy="16.5" r="4.5" />
    <path d="M17 14.3v2.2l1.4.9" />
  </>
), 0.16);

export const ContactCardIcon = icon("ContactCardIcon", (f) => (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.2" {...f} />
    <circle cx="8.5" cy="10.2" r="2" />
    <path d="M5.5 16c.5-1.6 1.6-2.5 3-2.5s2.5.9 3 2.5M14.5 10h4M14.5 14h4" />
  </>
), 0.12);

export const AddressBookIcon = icon("AddressBookIcon", (f) => (
  <>
    <path d="M6.5 3H18a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 18 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z" {...f} />
    <circle cx="12.2" cy="10" r="2.2" />
    <path d="M8.6 16.5c.5-1.5 1.9-2.5 3.6-2.5s3.1 1 3.6 2.5M3 7.5h4M3 12h4M3 16.5h4" />
  </>
), 0.12);

export const OfficeIcon = icon("OfficeIcon", (f) => (
  <>
    <rect x="5" y="3" width="14" height="18" rx="1.8" {...f} />
    <path d="M9 7h.01M12 7h.01M15 7h.01M9 10.5h.01M12 10.5h.01M15 10.5h.01M9 14h.01M12 14h.01M15 14h.01M10 21v-3.5h4V21" />
  </>
), 0.12);

export const BriefcaseIcon = icon("BriefcaseIcon", (f) => (
  <>
    <rect x="3" y="7.5" width="18" height="13" rx="2.2" {...f} />
    <path d="M8.5 7.5v-2A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5v2M3 13h18M12 11.8v2.4" />
  </>
), 0.12);

export const ShareNodesIcon = icon("ShareNodesIcon", (f) => (
  <>
    <path d="M7.3 11 16.7 6.6M7.3 13l9.4 4.4" />
    <circle cx="5" cy="12" r="2.5" {...f} />
    <circle cx="19" cy="5.5" r="2.5" {...f} />
    <circle cx="19" cy="18.5" r="2.5" {...f} />
  </>
), 0.16);

/* ---------------------------------------------------------------- documents */

export const InvoiceIcon = icon("InvoiceIcon", (f) => (
  <>
    <path d={DOCUMENT} {...f} />
    <path d="M8.5 12h7M8.5 15h7M8.5 18h4" />
  </>
), 0.1);

export const InvoiceCheckIcon = icon("InvoiceCheckIcon", (f) => (
  <>
    <path d={DOCUMENT} {...f} />
    <path d="M8.8 14.6l2.2 2.2 4.2-4.4" />
  </>
), 0.1);

/** A return going to HMRC: a document with an upward arrow. */
export const FilingIcon = icon("FilingIcon", (f) => (
  <>
    <path d={DOCUMENT} {...f} />
    <path d="M12 18v-6.5M9.2 14.2 12 11.4l2.8 2.8" />
  </>
), 0.1);

export const ReceiptIcon = icon("ReceiptIcon", (f) => (
  <>
    <path d={RECEIPT} {...f} />
    <path d="M9 8h6M9 11.5h6M9 15h3.5" />
  </>
), 0.12);

export const ReceiptCheckIcon = icon("ReceiptCheckIcon", (f) => (
  <>
    <path d={RECEIPT} {...f} />
    <path d="M8.8 10.8l2.2 2.2 4.2-4.4" />
  </>
), 0.12);

export const ClipboardIcon = icon("ClipboardIcon", (f) => (
  <>
    <path d={CLIPBOARD_FILL} {...f} stroke="none" />
    <path d={`${CLIPBOARD}M8 11h8M8 14.5h5M8 18h3`} />
  </>
), 0.16);

export const ClipboardCheckIcon = icon("ClipboardCheckIcon", (f) => (
  <>
    <path d={CLIPBOARD_FILL} {...f} stroke="none" />
    <path d={`${CLIPBOARD}M8.5 14.2l2.4 2.4 4.6-4.8`} />
  </>
), 0.16);

export const ClipboardPoundIcon = icon("ClipboardPoundIcon", (f) => (
  <>
    <path d={CLIPBOARD_FILL} {...f} stroke="none" />
    <path d={`${CLIPBOARD}M14.4 11.4a1.9 1.9 0 0 0-3.4 1.1V17.5M9.4 14.6h3.6M9.4 17.5h5.2`} />
  </>
), 0.16);

export const ClipboardClockIcon = icon("ClipboardClockIcon", (f) => (
  <>
    <path d={CLIPBOARD_FILL} {...f} stroke="none" />
    <path d={CLIPBOARD} />
    <circle cx="12" cy="14.2" r="3.9" />
    <path d="M12 12.3v1.9l1.3.9" />
  </>
), 0.12);

export const JournalIcon = icon("JournalIcon", (f) => (
  <>
    <path d="M6.5 3H19a.5.5 0 0 1 .5.5v17a.5.5 0 0 1-.5.5H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" {...f} />
    <path d="M4.5 18.5a2 2 0 0 1 2-2h13M9 7.5h6M9 11h4" />
  </>
), 0.12);

export const FolderCheckIcon = icon("FolderCheckIcon", (f) => (
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...f} />
    <path d="M8.8 13.4l2.2 2.2 4.2-4.4" />
  </>
), 0.12);

export const LicenceIcon = icon("LicenceIcon", (f) => (
  <>
    <rect x="3" y="4" width="18" height="13" rx="2.2" {...f} stroke="none" />
    <path d="M11.5 17H5.2A2.2 2.2 0 0 1 3 14.8V6.2A2.2 2.2 0 0 1 5.2 4h13.6A2.2 2.2 0 0 1 21 6.2v8.6a2.2 2.2 0 0 1-.8 1.7M7 8.5h7M7 12h3.5" />
    <circle cx="16" cy="14" r="2.9" />
    <path d="M14.3 16.4v5l1.7-1.1 1.7 1.1v-5" />
  </>
), 0.12);

/* ---------------------------------------------------------------- money */

export const BankIcon = icon("BankIcon", (f) => (
  <>
    <path d="M12 3 3 8v1.5h18V8z" {...f} />
    <path d="M5.5 12.5v5M10 12.5v5M14 12.5v5M18.5 12.5v5M4 17.5h16M3 20.5h18" />
  </>
), 0.16);

export const BanknoteIcon = icon("BanknoteIcon", (f) => (
  <>
    <rect x="3" y="5.5" width="18" height="13" rx="2.2" {...f} stroke="none" />
    <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
    <path d="M14 9.2a2 2 0 0 0-3.6 1.2V15M9 12.5h3.5M9 15h5.5" />
  </>
));

export const CoinsIcon = icon("CoinsIcon", (f) => (
  <>
    <circle cx="9.5" cy="9.5" r="6.5" {...f} />
    <path d="M18.3 10.6a6.5 6.5 0 1 1-7.7 7.7M11.4 7.6A1.6 1.6 0 0 0 8.5 8.6V12.4M7.2 10h2.9M7.2 12.4h4.3" />
  </>
), 0.14);

export const PercentIcon = icon("PercentIcon", (f) => (
  <>
    <circle cx="12" cy="12" r="9" {...f} />
    <path d="M15.5 8.5l-7 7" />
    <circle cx="9" cy="9" r="1.1" />
    <circle cx="15" cy="15" r="1.1" />
  </>
));

export const InterestIcon = icon("InterestIcon", (f) => (
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" {...f} />
    <path d="M15.5 8.5l-7 7" />
    <circle cx="9" cy="9" r="1.1" />
    <circle cx="15" cy="15" r="1.1" />
  </>
));

export const TrendUpIcon = icon("TrendUpIcon", (f) => (
  <>
    <path d="M3.5 17.5 9 12l4 3.5 7.5-8v13h-17z" {...f} stroke="none" />
    <path d="M3.5 17.5 9 12l4 3.5 7.5-8M15 7.5h5.5V13" />
  </>
));

export const ReportsIcon = icon("ReportsIcon", (f) => (
  <>
    <path d="M3.5 3.5v16a1 1 0 0 0 1 1h16" />
    <rect x="7" y="12" width="3" height="5" rx="0.7" {...f} />
    <rect x="12" y="8" width="3" height="9" rx="0.7" {...f} />
    <rect x="17" y="4.5" width="3" height="12.5" rx="0.7" {...f} />
  </>
), 0.2);

export const AccountsIcon = icon("AccountsIcon", (f) => (
  <>
    <rect x="3.5" y="3" width="7" height="4.5" rx="1.1" {...f} />
    <path d="M6.5 7.5V17a1.5 1.5 0 0 0 1.5 1.5h3M6.5 11.5H11" />
    <rect x="11" y="9.3" width="9.5" height="4.4" rx="1.1" />
    <rect x="11" y="16.3" width="9.5" height="4.4" rx="1.1" />
  </>
), 0.2);

export const CalculatorIcon = icon("CalculatorIcon", (f) => (
  <>
    <rect x="5" y="2.5" width="14" height="19" rx="2.2" {...f} />
    <rect x="8" y="5.5" width="8" height="3.5" rx="0.7" />
    <path d="M8.5 12.5h.01M12 12.5h.01M15.5 12.5h.01M8.5 15.5h.01M12 15.5h.01M8.5 18.5h.01M12 18.5h.01M15.5 15.5v3" />
  </>
), 0.12);

export const LockIcon = icon("LockIcon", (f) => (
  <>
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2" {...f} />
    <path d="M8 10.5v-3a4 4 0 0 1 8 0v3M12 14.3v2.9" />
  </>
), 0.16);

export const TagIcon = icon("TagIcon", (f) => (
  <>
    <path d="M3.5 5v6.2a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l6.2-6.2a2 2 0 0 0 0-2.8l-7.8-7.8A2 2 0 0 0 11.7 3H5.5a2 2 0 0 0-2 2z" {...f} />
    <circle cx="8" cy="7.5" r="1.2" />
  </>
), 0.12);

export const TransferIcon = icon("TransferIcon", () => (
  <path d="M4 8h14.5M15 4.5 18.5 8 15 11.5M20 16H5.5M9 12.5 5.5 16 9 19.5" />
));

/* ---------------------------------------------------------------- goods */

export const BoxIcon = icon("BoxIcon", (f) => (
  <>
    <path d="M12 3l8.5 4.5L12 12 3.5 7.5z" {...f} stroke="none" />
    <path d="M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9zM3.5 7.5 12 12l8.5-4.5M12 12v9M7.75 5.25l8.5 4.5" />
  </>
), 0.18);

export const BoxAlertIcon = icon("BoxAlertIcon", (f) => (
  <>
    <rect x="3.5" y="8" width="17" height="12.5" rx="2" {...f} />
    <path d="M3.7 8 5.6 4.2a1.2 1.2 0 0 1 1-.7h10.8a1.2 1.2 0 0 1 1 .7L20.3 8M12 11v4.5M12 18h.01" />
  </>
), 0.12);

export const GoodsInIcon = icon("GoodsInIcon", (f) => (
  <>
    <path d="M3.5 13H8l1.5 2.5h5L16 13h4.5v5.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" {...f} />
    <path d="M12 3.5V11M8.8 8 12 11.2 15.2 8" />
  </>
), 0.16);

export const PackagingIcon = icon("PackagingIcon", (f) => (
  <>
    <path d="M4.5 10.5 12 7.5l7.5 3L12 13.5z" {...f} stroke="none" />
    <path d="M4.5 10.5V18L12 21l7.5-3v-7.5M12 13.5 4.5 10.5l-2 3 7.5 3zM12 13.5l7.5-3 2 3-7.5 3zM12 13.5V21M4.5 10.5 12 7.5l7.5 3" />
  </>
), 0.18);

export const ReturnIcon = icon("ReturnIcon", (f) => (
  <>
    <path d="M15 9.5a5 5 0 0 1 0 10H9v-10z" {...f} stroke="none" />
    <path d="M8 5.5l-4 4 4 4M4 9.5h11a5 5 0 0 1 0 10H9" />
  </>
), 0.16);

export const WarehouseIcon = icon("WarehouseIcon", (f) => (
  <>
    <path d="M3 9.5 12 4l9 5.5v11H3z" {...f} />
    <path d="M7 20.5v-8h10v8M7 15.3h10M7 18h10" />
  </>
), 0.12);

export const StoreIcon = icon("StoreIcon", (f) => (
  <>
    <path d="M3 9.5 4.6 4.8A1.2 1.2 0 0 1 5.7 4h12.6a1.2 1.2 0 0 1 1.1.8L21 9.5z" {...f} />
    <path d="M4.5 9.5V20h15V9.5M10 20v-5.5h4V20" />
  </>
), 0.18);

export const BagIcon = icon("BagIcon", (f) => (
  <>
    <path d="M5.5 8h13l1.2 11.2a1.5 1.5 0 0 1-1.5 1.8H5.8a1.5 1.5 0 0 1-1.5-1.8z" {...f} />
    <path d="M8.5 10.5V6.5a3.5 3.5 0 0 1 7 0v4" />
  </>
), 0.12);

export const ShipIcon = icon("ShipIcon", (f) => (
  <>
    <path d="M2.5 14h19l-2.3 5.6a1.5 1.5 0 0 1-1.4.9H6.2a1.5 1.5 0 0 1-1.4-.9z" {...f} />
    <path d="M6 14v-3.8h5.5V14M11.5 14V6.5H18V14M14.7 6.5v2.4" />
  </>
), 0.18);

export const TruckIcon = icon("TruckIcon", (f) => (
  <>
    <path d="M2.5 7.5A1.5 1.5 0 0 1 4 6h9a1.5 1.5 0 0 1 1.5 1.5V17H4a1.5 1.5 0 0 1-1.5-1.5z" {...f} stroke="none" />
    <path d="M5.4 17H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 6h9a1.5 1.5 0 0 1 1.5 1.5V17M9.6 17h4.9M14.5 10h3.6a1 1 0 0 1 .8.4l2.4 3a1 1 0 0 1 .2.6v2a1 1 0 0 1-1 1h-.9" />
    <circle cx="7.5" cy="17.5" r="2.1" />
    <circle cx="17.5" cy="17.5" r="2.1" />
  </>
));

export const RouteIcon = icon("RouteIcon", (f) => (
  <>
    <path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5" />
    <circle cx="6" cy="19" r="2.5" {...f} />
    <circle cx="18" cy="5" r="2.5" {...f} />
  </>
), 0.18);

export const MapPinIcon = icon("MapPinIcon", (f) => (
  <>
    <path d="M12 21.5s7-6 7-11.5a7 7 0 1 0-14 0c0 5.5 7 11.5 7 11.5z" {...f} />
    <circle cx="12" cy="10" r="2.5" />
  </>
));

export const RulerIcon = icon("RulerIcon", (f) => (
  <>
    <rect x="2.5" y="8" width="19" height="8" rx="1.6" {...f} />
    <path d="M6.5 8v2.5M10.2 8v4M13.8 8v2.5M17.5 8v4" />
  </>
));

export const ShapesIcon = icon("ShapesIcon", (f) => (
  <>
    <path d="M7.5 3.5l4 6.8h-8z" {...f} />
    <circle cx="17" cy="7" r="3.7" />
    <rect x="3.7" y="13.5" width="7.2" height="7.2" rx="1.4" />
    <circle cx="17" cy="17" r="3.7" {...f} />
  </>
), 0.18);

/* ---------------------------------------------------------------- site and factory */

export const HardHatIcon = icon("HardHatIcon", (f) => (
  <>
    <path d="M4 16a8 8 0 0 1 16 0z" {...f} stroke="none" />
    <path d="M4 16a8 8 0 0 1 6-7.7M14 8.3a8 8 0 0 1 6 7.7M10 12V5.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V12M2.5 16h19v1.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5z" />
  </>
), 0.16);

export const HammerIcon = icon("HammerIcon", (f) => (
  <>
    <path d="M6.5 3.5h9L20 7v2.5h-4L14.5 8.5h-8a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" {...f} />
    <path d="M10.5 8.5V19.5a1.75 1.75 0 0 0 3.5 0V8.5" />
  </>
), 0.16);

export const BricksIcon = icon("BricksIcon", (f) => (
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="1.8" {...f} />
    <path d="M3.5 9.7h17M3.5 14.3h17M9.2 5v4.7M14.8 5v4.7M6.5 9.7v4.6M12 9.7v4.6M17.5 9.7v4.6M9.2 14.3V19M14.8 14.3V19" />
  </>
), 0.12);

export const FactoryIcon = icon("FactoryIcon", (f) => (
  <>
    <path d="M3 20.5V10.3a.5.5 0 0 1 .8-.4L9 13.5v-3.2a.5.5 0 0 1 .8-.4l5.2 3.6V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v15z" {...f} />
    <path d="M7 17.2h.01M12 17.2h.01M17 17.2h.01" />
  </>
), 0.12);

export const GearIcon = icon("GearIcon", (f) => (
  <>
    <circle cx="12" cy="12" r="6" {...f} />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 2.5V6M12 18v3.5M2.5 12H6M18 12h3.5M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M5.3 18.7l2.5-2.5M16.2 7.8l2.5-2.5" />
  </>
), 0.16);

export const GaugeIcon = icon("GaugeIcon", (f) => (
  <>
    <path d="M3.5 17a9 9 0 1 1 17 0z" {...f} stroke="none" />
    <path d="M3.5 17a9 9 0 1 1 17 0M12 14l3.8-4.8M6 20.5h12" />
    <circle cx="12" cy="14" r="1.5" />
  </>
));

export const BomIcon = icon("BomIcon", (f) => (
  <>
    <rect x="9" y="3" width="6" height="4.5" rx="1.1" {...f} />
    <path d="M12 7.5V15M5.5 15v-2.5A1.5 1.5 0 0 1 7 11h10a1.5 1.5 0 0 1 1.5 1.5V15" />
    <rect x="3" y="15" width="5" height="5.5" rx="1.1" />
    <rect x="9.5" y="15" width="5" height="5.5" rx="1.1" />
    <rect x="16" y="15" width="5" height="5.5" rx="1.1" />
  </>
), 0.2);

/* ---------------------------------------------------------------- compliance */

export const ShieldCheckIcon = icon("ShieldCheckIcon", (f) => (
  <>
    <path d="M12 2.8l7.5 2.7v6c0 4.6-3 7.8-7.5 9.7-4.5-1.9-7.5-5.1-7.5-9.7v-6z" {...f} />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </>
), 0.12);

export const LayersIcon = icon("LayersIcon", (f) => (
  <>
    <path d="M12 2.5l9 5-9 5-9-5z" {...f} />
    <path d="M3 12l9 5 9-5M3 16.5l9 5 9-5" />
  </>
), 0.18);

export const RecallIcon = icon("RecallIcon", (f) => (
  <>
    <path d={WARNING} {...f} />
    <path d="M12 9.5V14M12 17.3v.2" />
  </>
), 0.16);

export const SnowflakeIcon = icon("SnowflakeIcon", (f) => (
  <>
    <circle cx="12" cy="12" r="4" {...f} stroke="none" />
    <path d="M12 2.5v19M3.8 7.25l16.4 9.5M20.2 7.25 3.8 16.75M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5M4.2 10.9l3.4-.9-.9-3.4M19.8 13.1l-3.4.9.9 3.4M19.8 10.9l-3.4-.9.9-3.4M4.2 13.1l3.4.9-.9 3.4" />
  </>
), 0.18);

export const PillIcon = icon("PillIcon", (f) => (
  <g transform="rotate(-45 12 12)">
    <path d="M12 8h5.5a4 4 0 0 1 0 8H12z" {...f} stroke="none" />
    <rect x="2.5" y="8" width="19" height="8" rx="4" />
    <path d="M12 8v8" />
  </g>
), 0.2);

export const TriangleNodesIcon = icon("TriangleNodesIcon", (f) => (
  <>
    <path d="M10.8 7.2 6.2 15.8M13.2 7.2l4.6 8.6M7.5 18h9" />
    <circle cx="12" cy="5" r="2.5" {...f} />
    <circle cx="5" cy="18" r="2.5" {...f} />
    <circle cx="19" cy="18" r="2.5" {...f} />
  </>
), 0.18);

export const CalendarCheckIcon = icon("CalendarCheckIcon", (f) => (
  <>
    <path d={CALENDAR_HEAD} {...f} stroke="none" />
    <path d={`${CALENDAR}M8.8 15l2.2 2.2 4.2-4.4`} />
  </>
));

export const CalendarAlertIcon = icon("CalendarAlertIcon", (f) => (
  <>
    <path d={CALENDAR_HEAD} {...f} stroke="none" />
    <path d={`${CALENDAR}M12 13v2.8M12 18h.01`} />
  </>
));

export const UmbrellaIcon = icon("UmbrellaIcon", (f) => (
  <>
    <path d={UMBRELLA_TOP} {...f} stroke="none" />
    <path d={`${UMBRELLA_TOP}M12 4c-2.4 2.2-3.4 5-3.4 8.5M12 4c2.4 2.2 3.4 5 3.4 8.5M12 12.5v6.2a1.8 1.8 0 0 1-3.6 0M12 2.5V4`} />
  </>
));

/* ---------------------------------------------------------------- food and drink */

export const ChefHatIcon = icon("ChefHatIcon", (f) => (
  <>
    <path d="M7 14.5a4 4 0 0 1-.8-7.9 6 6 0 0 1 11.6 0 4 4 0 0 1-.8 7.9z" {...f} stroke="none" />
    <path d="M7 14.5a4 4 0 0 1-.8-7.9 6 6 0 0 1 11.6 0 4 4 0 0 1-.8 7.9v5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zM7 17h10" />
  </>
), 0.16);

export const BarrelIcon = icon("BarrelIcon", (f) => (
  <>
    <path d="M7 3h10c1.7 2.6 2.5 5.6 2.5 9s-.8 6.4-2.5 9H7c-1.7-2.6-2.5-5.6-2.5-9S5.3 5.6 7 3z" {...f} />
    <path d="M5.2 8h13.6M5.2 16h13.6" />
  </>
), 0.14);

export const BottleIcon = icon("BottleIcon", (f) => (
  <>
    <path d="M7.5 13h9v5h-9z" {...f} stroke="none" />
    <path d="M10 2.5h4v3.2c0 .8.4 1.4 1 2 1 .9 1.5 2 1.5 3.3v9a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9c0-1.3.5-2.4 1.5-3.3.6-.6 1-1.2 1-2zM7.5 13h9M7.5 18h9" />
  </>
), 0.2);

export const RecycleIcon = icon("RecycleIcon", (f) => (
  <>
    <circle cx="12" cy="12" r="8.5" {...f} stroke="none" />
    <path d="M20.5 12a8.5 8.5 0 0 1-14.7 5.8l-2.3-2.3M3.5 12a8.5 8.5 0 0 1 14.7-5.8l2.3 2.3M3.5 20v-4.5H8M20.5 4v4.5H16" />
  </>
), 0.12);

export const WheatIcon = icon("WheatIcon", (f) => (
  <>
    <path d="M12 8c-2.4 0-3.8-1.4-3.8-3.8 2.4 0 3.8 1.4 3.8 3.8zM12 8c2.4 0 3.8-1.4 3.8-3.8-2.4 0-3.8 1.4-3.8 3.8zM12 13c-2.4 0-3.8-1.4-3.8-3.8 2.4 0 3.8 1.4 3.8 3.8zM12 13c2.4 0 3.8-1.4 3.8-3.8-2.4 0-3.8 1.4-3.8 3.8zM12 18c-2.4 0-3.8-1.4-3.8-3.8 2.4 0 3.8 1.4 3.8 3.8zM12 18c2.4 0 3.8-1.4 3.8-3.8-2.4 0-3.8 1.4-3.8 3.8z" {...f} />
    <path d="M12 2.5v19" />
  </>
), 0.18);

export const UtensilsIcon = icon("UtensilsIcon", (f) => (
  <>
    <path d="M18 14V3c-2.8 1-4.5 3.8-4.5 7.5 0 2 1 3.5 2.5 3.5z" {...f} />
    <path d="M18 14v7M5 3v5a2.75 2.75 0 0 0 5.5 0V3M7.75 3v18" />
  </>
), 0.16);
