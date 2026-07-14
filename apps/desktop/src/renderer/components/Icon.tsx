import type { SVGProps } from 'react';

export type IconName =
  | 'logo'
  | 'files'
  | 'search'
  | 'book'
  | 'tools'
  | 'sparkles'
  | 'settings'
  | 'chevronRight'
  | 'chevronDown'
  | 'folder'
  | 'folderOpen'
  | 'file'
  | 'filePlus'
  | 'folderPlus'
  | 'tex'
  | 'pdf'
  | 'doc'
  | 'code'
  | 'plus'
  | 'refresh'
  | 'more'
  | 'close'
  | 'save'
  | 'panel'
  | 'command'
  | 'arrowRight'
  | 'clock'
  | 'gitBranch'
  | 'bell'
  | 'warning'
  | 'info'
  | 'error'
  | 'check'
  | 'play'
  | 'stop'
  | 'external'
  | 'upload'
  | 'link'
  | 'user'
  | 'logout'
  | 'shield'
  | 'send'
  | 'paperclip'
  | 'key'
  | 'globe'
  | 'chat'
  | 'device'
  | 'copy'
  | 'pin'
  | 'trash'
  | 'edit'
  | 'terminal'
  | 'database'
  | 'quote'
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'subscript'
  | 'superscript'
  | 'highlight'
  | 'list'
  | 'orderedList'
  | 'heading'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignJustify'
  | 'lineSpacing'
  | 'spacingBefore'
  | 'spacingAfter'
  | 'indentFirst'
  | 'indentLeft'
  | 'indentRight'
  | 'fontFamily'
  | 'fontSize'
  | 'textColor'
  | 'table'
  | 'columnAdd'
  | 'columnDelete'
  | 'rowAdd'
  | 'rowDelete'
  | 'mergeCells'
  | 'splitCell'
  | 'tableDelete'
  | 'zoomIn'
  | 'zoomOut'
  | 'previous'
  | 'next'
  | 'maximize'
  | 'minimize'
  | 'lock'
  | 'cpu'
  | 'download'
  | 'filter'
  | 'history'
  | 'archive';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

function Paths({ name }: { name: IconName }) {
  switch (name) {
    case 'logo':
      return <><path d="M5 4.75h8.2a3.3 3.3 0 0 1 3.3 3.3v11.2H8.3A3.3 3.3 0 0 1 5 15.95V4.75Z"/><path d="M8.25 8h5M8.25 11h5M8.25 14h2.7"/><path d="m16.5 8 2.75-2.2v13.45H16.5"/></>;
    case 'files':
      return <><path d="M14 3H6a2 2 0 0 0-2 2v12"/><path d="M8 7h8a2 2 0 0 1 2 2v10H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/></>;
    case 'search':
      return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.4 15.4 4.1 4.1"/></>;
    case 'book':
      return <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v15h4.5a2.5 2.5 0 0 1 2.5 2.5v-15Z"/></>;
    case 'tools':
      return <><path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.4 2.4-2.1-2.1a4 4 0 0 0 5 5l7 7a2 2 0 0 1-2.8 2.8l-7-7"/><path d="m6.5 13.5-4 4a2 2 0 0 0 2.8 2.8l4-4"/></>;
    case 'sparkles':
      return <><path d="m12 3 1.15 3.35L16.5 7.5l-3.35 1.15L12 12l-1.15-3.35L7.5 7.5l3.35-1.15L12 3Z"/><path d="m6 12 .85 2.15L9 15l-2.15.85L6 18l-.85-2.15L3 15l2.15-.85L6 12Z"/><path d="m17.5 12 .75 1.75 1.75.75-1.75.75L17.5 17l-.75-1.75L15 14.5l1.75-.75.75-1.75Z"/></>;
    case 'settings':
      return <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.17a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06L7.04 4.3l.06.06a1.65 1.65 0 0 0 1.82.33h.08A1.65 1.65 0 0 0 10 3.17V3h4v.17a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.4 9v.08A1.65 1.65 0 0 0 20.91 10H21v4h-.09A1.65 1.65 0 0 0 19.4 15Z"/></>;
    case 'chevronRight': return <path d="m9 18 6-6-6-6"/>;
    case 'chevronDown': return <path d="m6 9 6 6 6-6"/>;
    case 'folder': return <path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z"/>;
    case 'folderOpen': return <><path d="M3 8V6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3.5 19.5h15l3-10h-15l-3 10Z"/></>;
    case 'file': return <><path d="M6 2.5h8l4 4v15H6v-19Z"/><path d="M14 2.5v4h4"/></>;
    case 'filePlus': return <><path d="M6 2.5h8l4 4v15H6v-19Z"/><path d="M14 2.5v4h4M9 14h6M12 11v6"/></>;
    case 'folderPlus': return <><path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z"/><path d="M9 13h6M12 10v6"/></>;
    case 'tex': return <><path d="M6 2.5h8l4 4v15H6v-19Z"/><path d="M14 2.5v4h4"/><path d="M8.5 11h7M12 11v6M9.5 17h5"/></>;
    case 'pdf': return <><path d="M6 2.5h8l4 4v15H6v-19Z"/><path d="M14 2.5v4h4"/><path d="M8 16c2-5 3-7 4-7s.5 7 4 7c-3-2-5-2-8 0Z"/></>;
    case 'doc': return <><path d="M6 2.5h8l4 4v15H6v-19Z"/><path d="M14 2.5v4h4M9 11h6M9 14h6M9 17h4"/></>;
    case 'code': return <><path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14"/></>;
    case 'plus': return <path d="M12 5v14M5 12h14"/>;
    case 'refresh': return <><path d="M20 7v5h-5"/><path d="M18.2 16a8 8 0 1 1 .9-9L20 12"/></>;
    case 'more': return <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>;
    case 'close': return <path d="m6 6 12 12M18 6 6 18"/>;
    case 'save': return <><path d="M4 3h14l2 2v16H4V3Z"/><path d="M8 3v6h8V3M8 21v-8h8v8"/></>;
    case 'panel': return <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15h18"/></>;
    case 'command': return <><path d="M9 6H6a3 3 0 1 1 3-3v6ZM15 6h3a3 3 0 1 0-3-3v6ZM9 18H6a3 3 0 1 0 3 3v-6ZM15 18h3a3 3 0 1 1-3 3v-6Z"/><path d="M9 6h6v12H9z"/></>;
    case 'arrowRight': return <><path d="M5 12h14M13 6l6 6-6 6"/></>;
    case 'clock': return <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>;
    case 'gitBranch': return <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 8c0 5-4 5-8 5H6"/></>;
    case 'bell': return <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></>;
    case 'warning': return <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17.5v.5"/></>;
    case 'info': return <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></>;
    case 'error': return <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>;
    case 'check': return <path d="m5 12 4 4L19 6"/>;
    case 'play': return <path d="m8 5 11 7-11 7V5Z"/>;
    case 'stop': return <rect x="6" y="6" width="12" height="12" rx="1"/>;
    case 'external': return <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>;
    case 'upload': return <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/></>;
    case 'download': return <><path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 19h16"/></>;
    case 'link': return <><path d="m9 15-2 2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/><path d="m15 9 2-2a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0M8 12h8"/></>;
    case 'user': return <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>;
    case 'logout': return <><path d="M10 5H4v14h6M14 8l4 4-4 4M8 12h10"/></>;
    case 'shield': return <><path d="M12 2.5 20 6v5c0 5.2-3.3 8.7-8 10.5C7.3 19.7 4 16.2 4 11V6l8-3.5Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>;
    case 'send': return <><path d="m3 3 19 9-19 9 3-9-3-9Z"/><path d="M6 12h16"/></>;
    case 'paperclip': return <path d="m20 11.5-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>;
    case 'key': return <><circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9M16 7l2 2M13.5 9.5l2 2"/></>;
    case 'globe': return <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></>;
    case 'chat': return <path d="M4 4h16v13H9l-5 4V4Z"/>;
    case 'device': return <><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 5h6M11 18h2"/></>;
    case 'copy': return <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>;
    case 'pin': return <><path d="m9 3 6 6M7 10l7 7M6 9l5-5 7 7-5 5M9 15l-6 6"/></>;
    case 'trash': return <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>;
    case 'edit': return <><path d="m14 4 6 6L9 21H3v-6L14 4Z"/><path d="m12 6 6 6"/></>;
    case 'terminal': return <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>;
    case 'database': return <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>;
    case 'quote': return <><path d="M9 11H4c0-4 1.5-6 5-7v3c-1.5.5-2 1.5-2 2h2v7H3v-5M21 11h-5c0-4 1.5-6 5-7v3c-1.5.5-2 1.5-2 2h2v7h-6v-5"/></>;
    case 'undo': return <><path d="m9 7-5 5 5 5"/><path d="M20 18c0-4-3-6-8-6H4"/></>;
    case 'redo': return <><path d="m15 7 5 5-5 5"/><path d="M4 18c0-4 3-6 8-6h8"/></>;
    case 'bold': return <><path d="M7 4h6a4 4 0 0 1 0 8H7V4ZM7 12h7a4 4 0 0 1 0 8H7v-8Z"/></>;
    case 'italic': return <><path d="M10 4h8M6 20h8M14 4l-4 16"/></>;
    case 'underline': return <><path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14"/></>;
    case 'subscript': return <><path d="m5 6 8 10M13 6 5 16M15 17c0-2.5 4-2.5 4 0 0 1.6-4 2.3-4 4h4"/></>;
    case 'superscript': return <><path d="m5 8 8 10M13 8 5 18M15 4c0-2.5 4-2.5 4 0 0 1.6-4 2.3-4 4h4"/></>;
    case 'highlight': return <><path d="m14 4 6 6-9 9H5v-6l9-9ZM11 7l6 6M4 22h16"/><path d="m5 19 4 3"/></>;
    case 'list': return <><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".7" fill="currentColor"/><circle cx="4.5" cy="12" r=".7" fill="currentColor"/><circle cx="4.5" cy="18" r=".7" fill="currentColor"/></>;
    case 'orderedList': return <><path d="M10 6h10M10 12h10M10 18h10M4 4v4M3 4h1M3 10h3l-3 4h3M3 18c0-2 3-2 3 0s-3 2-3 0M6 20v-4"/></>;
    case 'heading': return <><path d="M5 5v14M15 5v14M5 12h10M18 10h2v9M18 19h4"/></>;
    case 'alignLeft': return <path d="M4 5h16M4 9h11M4 13h16M4 17h11M4 21h16"/>;
    case 'alignCenter': return <path d="M4 5h16M7 9h10M4 13h16M7 17h10M4 21h16"/>;
    case 'alignRight': return <path d="M4 5h16M9 9h11M4 13h16M9 17h11M4 21h16"/>;
    case 'alignJustify': return <path d="M4 5h16M4 9h16M4 13h16M4 17h16M4 21h16"/>;
    case 'lineSpacing': return <><path d="M8 5h12M8 10h12M8 15h12M8 20h12M4 5v15M2 7l2-2 2 2M2 18l2 2 2-2"/></>;
    case 'spacingBefore': return <><path d="M7 10h13M7 15h13M7 20h13M3 8l2-2 2 2M5 6v4"/></>;
    case 'spacingAfter': return <><path d="M7 4h13M7 9h13M7 14h13M3 16l2 2 2-2M5 14v4"/></>;
    case 'indentFirst': return <><path d="M10 5h10M5 10h15M5 15h15M5 20h15M3 5h4M5 3l2 2-2 2"/></>;
    case 'indentLeft': return <><path d="M10 5h10M10 10h10M10 15h10M10 20h10M3 12h5M6 9l3 3-3 3"/></>;
    case 'indentRight': return <><path d="M4 5h10M4 10h10M4 15h10M4 20h10M16 12h5M18 9l-3 3 3 3"/></>;
    case 'fontFamily': return <><path d="M5 19 10 5h4l5 14M7 14h10M3 5h18"/></>;
    case 'fontSize': return <><path d="M4 6h11M9.5 6v13M5 19h9M16 11h5M18.5 8.5v5"/></>;
    case 'textColor': return <><path d="M5 18 10 5h4l5 13M7 13h10M4 22h16"/></>;
    case 'table': return <><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16M15 4v16"/></>;
    case 'columnAdd': return <><rect x="3" y="5" width="13" height="14" rx="1"/><path d="M9.5 5v14M19 8v8M15 12h8"/></>;
    case 'columnDelete': return <><rect x="3" y="5" width="13" height="14" rx="1"/><path d="M9.5 5v14M17 9l5 5M22 9l-5 5"/></>;
    case 'rowAdd': return <><rect x="4" y="3" width="16" height="13" rx="1"/><path d="M4 9.5h16M8 19h8M12 15v8"/></>;
    case 'rowDelete': return <><rect x="4" y="3" width="16" height="13" rx="1"/><path d="M4 9.5h16M8 18l8 4M16 18l-8 4"/></>;
    case 'mergeCells': return <><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14M15 5v14M6 12h12M10 9l-3 3 3 3M14 9l3 3-3 3"/></>;
    case 'splitCell': return <><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M12 5v14M10 9l-3 3 3 3M14 9l3 3-3 3"/></>;
    case 'tableDelete': return <><rect x="3" y="5" width="14" height="14" rx="1"/><path d="M3 11h14M8 5v14M12 5v14M17 8l5 8M22 8l-5 8"/></>;
    case 'zoomIn': return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="M10.5 7.5v6M7.5 10.5h6m2.9 4.9 4.1 4.1"/></>;
    case 'zoomOut': return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6m2.9 4.9 4.1 4.1"/></>;
    case 'previous': return <><path d="m14 18-6-6 6-6"/></>;
    case 'next': return <><path d="m10 18 6-6-6-6"/></>;
    case 'maximize': return <rect x="4" y="4" width="16" height="16" rx="2"/>;
    case 'minimize': return <path d="M5 12h14"/>;
    case 'lock': return <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>;
    case 'cpu': return <><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M10 10h4v4h-4z"/></>;
    case 'filter': return <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>;
    case 'history': return <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>;
    case 'archive': return <><path d="M3 5h18v4H3V5Z"/><path d="M5 9v11h14V9M9 13h6"/></>;
  }
}

export function Icon({ name, size = 18, className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.65"
      {...props}
    >
      <Paths name={name} />
    </svg>
  );
}
