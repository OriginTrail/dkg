import React, { useId } from 'react';
import { ChevronRight } from 'lucide-react';

interface SidebarSectionProps {
  label: string;
  /** Whether the body shows; the caller keeps it, so each section's stored state stays where it is. */
  open: boolean;
  onToggle: () => void;
  /**
   * A product section's icon, before the label. A section with one gets the
   * product header and its chevron at the end; one without leads with the
   * chevron.
   */
  icon?: React.ReactNode;
  /** A count after the label. */
  count?: number;
  /** The header shows the section as the current place, as Marketplace does while one of its tabs is open. */
  active?: boolean;
  /** Extra classes for the section, and for its body. */
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * A collapsible sidebar group: a header button that discloses the body, with
 * `aria-expanded` and `aria-controls` naming it, and a chevron that turns. A
 * collapsed body is not mounted, so whatever runs inside it (the
 * Integrations poll, say) stops while it is closed.
 */
export function SidebarSection({ label, open, onToggle, icon, count, active = false, className, bodyClassName, children }: SidebarSectionProps) {
  const bodyId = useId();
  const chevron = <ChevronRight size={14} className={`v10-peer-group-chevron ${open ? 'expanded' : ''}`} aria-hidden="true" />;
  const header = ['v10-peer-group-header', 'v10-sidebar-group-header', ...(icon ? ['v10-sidebar-product-header'] : []), ...(active ? ['active'] : [])].join(' ');
  return (
    <div className={`v10-peer-group v10-sidebar-group${className ? ` ${className}` : ''}`}>
      <button type="button" className={header} aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        {icon ?? chevron}
        <span className="v10-peer-group-label">{label}</span>
        {count !== undefined && <span className="v10-peer-group-count">{count}</span>}
        {icon ? chevron : null}
      </button>
      {open && (
        <div id={bodyId} className={`v10-peer-group-body v10-sidebar-group-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
          {children}
        </div>
      )}
    </div>
  );
}
