/* ============================================================
   Delivery sheet PDF generation (jsPDF + autotable + QR)
   ============================================================ */
(function () {
  'use strict';

  const fmtT = d => d.toTimeString().slice(0, 5);

  function qrDataUrl(text, size) {
    const holder = document.createElement('div');
    holder.style.position = 'fixed'; holder.style.left = '-9999px';
    document.body.appendChild(holder);
    new QRCode(holder, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
    const canvas = holder.querySelector('canvas');
    const url = canvas ? canvas.toDataURL('image/png') : null;
    document.body.removeChild(holder);
    return url;
  }

  function vanPdf(van, settings) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, M = 12;
    const color = van.color || '#1f5fa8';
    const rgb = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
    const dateStr = new Date(settings.date + 'T12:00:00').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Header band
    doc.setFillColor(rgb[0], rgb[1], rgb[2]);
    doc.rect(0, 0, W, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('BLIND DESIGNS — DELIVERY SHEET', M, 9.5);
    doc.setFontSize(11); doc.text(van.name.toUpperCase(), M, 16.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(dateStr, W - M, 9.5, { align: 'right' });
    doc.text('Driver: ____________________', W - M, 16.5, { align: 'right' });

    // Meta strip
    doc.setTextColor(40, 40, 40); doc.setFontSize(9);
    const tl = van.timeline;
    const meta = [
      'Departs: ' + settings.departTime,
      'Stops: ' + van.stops.length,
      'Est. drive: ' + Math.round(tl.driveMin) + ' min · ' + Math.round(tl.km) + ' km',
      'Est. back: ' + fmtT(tl.returnAt),
      'AIM TO BE BACK BY: ' + fmtT(tl.returnBy)
    ];
    doc.setFillColor(242, 245, 248);
    doc.rect(0, 22, W, 9, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text(meta.join('      '), M, 27.8);

    // Return-time note
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.8); doc.setTextColor(110, 110, 110);
    doc.text('"Aim to be back by" includes ' + settings.leewayPct + '% traffic leeway on top of the routed estimate. Load for tomorrow on return — latest ' + settings.hardReturn + '.', M, 35);

    // Route map (optional — supplied when the Maps Static API is available)
    let tableStart = 38;
    if (van.map && van.map.dataUrl) {
      const mw = W - 2 * M;              // 186 mm wide
      const mh = mw * 360 / 640;         // keep 640x360 aspect ≈ 104.6 mm
      try {
        doc.addImage(van.map.dataUrl, 'PNG', M, 37.5, mw, mh);
        doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(0.4);
        doc.rect(M, 37.5, mw, mh);       // neat border in van colour
        doc.setFont('helvetica', 'italic'); doc.setFontSize(7.2); doc.setTextColor(110, 110, 110);
        doc.text(van.map.legend || 'Map pins match the stop numbers below.', M, 37.5 + mh + 3.6);
        tableStart = 37.5 + mh + 6.5;
      } catch (e) { console.warn('map embed failed', e); tableStart = 38; }
    }

    // Stops table — rows are in exact delivery order (# = drive sequence)
    const body = tl.seq.map((leg, i) => {
      const s = leg.stop;
      return [
        String(i + 1),
        fmtT(leg.eta),
        (s.name || '') + (s.phone ? '\n' + s.phone : ''),
        (s.address || '') + (s.area ? '\n[' + s.area + ']' : ''),
        (s.orders || []).join('\n') || '—',
        ''
      ];
    });
    doc.autoTable({
      startY: tableStart,
      head: [['#', 'ETA', 'Customer / phone', 'Address', 'Orders', 'Delivered  (sign)']],
      body,
      margin: { left: M, right: M, top: 38, bottom: 26 },
      styles: { fontSize: 8, cellPadding: 1.8, valign: 'top', lineColor: [205, 213, 222], lineWidth: 0.15 },
      headStyles: { fillColor: rgb, textColor: 255, fontSize: 8.3 },
      alternateRowStyles: { fillColor: [246, 248, 250] },
      columnStyles: {
        0: { cellWidth: 7, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 12, fontStyle: 'bold' },
        2: { cellWidth: 42 },
        3: { cellWidth: 62 },
        4: { cellWidth: 26 },
        5: { cellWidth: 37 }
      },
      didDrawCell: d => {
        if (d.section === 'body' && d.column.index === 5) {
          doc.setDrawColor(150); doc.setLineWidth(0.25);
          doc.rect(d.cell.x + 2, d.cell.y + 1.5, 4, 4);   // tick box
          doc.line(d.cell.x + 8, d.cell.y + d.cell.height - 2, d.cell.x + d.cell.width - 2, d.cell.y + d.cell.height - 2);
        }
      },
      didDrawPage: () => {
        doc.setFontSize(7.5); doc.setTextColor(130);
        doc.text('Blind Designs · 011 683 0080 · Generated ' + new Date().toLocaleString('en-ZA'), M, 291);
        doc.text('Page ' + doc.internal.getNumberOfPages(), W - M, 291, { align: 'right' });
      }
    });

    // Navigation QR block
    let y = doc.lastAutoTable.finalY + 8;
    const links = van.links || [];
    const qrSize = 30, needed = 14 + qrSize;
    if (y + needed > 280) { doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(40);
    doc.text('Navigate this route — scan with your phone (Google Maps)', M, y);
    y += 4;
    links.forEach((link, i) => {
      const x = M + i * (qrSize + 22);
      if (x + qrSize > W - M) return;
      const url = qrDataUrl(link, 200);
      if (url) doc.addImage(url, 'PNG', x, y, qrSize, qrSize);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text(links.length > 1 ? 'Leg ' + (i + 1) : 'Full route', x + qrSize / 2, y + qrSize + 4, { align: 'center' });
    });
    y += qrSize + 10;
    if (y + 22 < 285) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text('Notes / issues:', M, y);
      doc.setDrawColor(180); doc.setLineWidth(0.2);
      for (let i = 1; i <= 3; i++) doc.line(M, y + i * 6, W - M, y + i * 6);
    }

    const fname = 'DeliverySheet_' + van.name.replace(/\s+/g, '') + '_' + settings.date + '.pdf';
    doc.save(fname);
    return fname;
  }

  window.PdfGen = { vanPdf };
})();
