// A page's title block: the one h1 on the page, its one-line purpose, and an
// optional badge beside the title. Put it inside a `ds-page`. DESIGN.md · Layout.
import React from 'react';

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
}

export function PageHeader({ title, description, badge }: PageHeaderProps) {
  return (
    <header className="ds-page-header">
      <div className="ds-page-titlerow">
        <h1 className="ds-page-title">{title}</h1>
        {badge}
      </div>
      {description && <p className="ds-page-desc">{description}</p>}
    </header>
  );
}
