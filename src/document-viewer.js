/*
 * Document Viewer region plug-in for Oracle APEX (TechRevX, www.techrevx.com)
 *
 * techrevx.documentViewer.init( regionId ) is called by the render procedure. It reads the settings and the
 * document list from the JSON block #<regionId>_documents and builds the viewer in #<regionId>_viewer:
 * a document list (Layout = Document List), a toolbar and a stage that previews the open document.
 *
 * Renderers by type: PDF (PDF.js, loaded on first use from the plug-in files), image, text / CSV / JSON,
 * video and audio; anything else gets a file card with a download button.
 * Files come from the plug-in's AJAX callback (x01 = FILE, x02 = id) or from the row's URL.
 *
 * apex.region( regionId ).refresh()      reloads the document list
 * apex.region( regionId ).open( id )     opens a document
 * Events on the region: tx-docviewer-select { id, name, mimeType }, tx-docviewer-load { id, name, mimeType, pages }.
 */
( function( $, apex ) {
    "use strict";

    const ns = window.techrevx = window.techrevx || {};
    let pdfjsPromise = null;

    const MIME_BY_EXT = {
        pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", txt: "text/plain", log: "text/plain", md: "text/markdown",
        csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml", sql: "text/plain",
        js: "text/javascript", css: "text/css", html: "text/html", htm: "text/html", yaml: "text/plain", yml: "text/plain",
        mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
        ogg: "audio/ogg", m4a: "audio/mp4", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        zip: "application/zip"
    };
    const TEXT_LIMIT = 2 * 1024 * 1024;

    const esc = v => apex.util.escapeHTML( v === null || v === undefined ? "" : String( v ) );
    const has = ( list, flag ) => String( list || "" ).split( ":" ).indexOf( flag ) > -1;

    function mimeOf( doc ) {
        if ( doc.m ) { return String( doc.m ).toLowerCase(); }
        const ext = String( doc.n || "" ).split( "." ).pop().toLowerCase();
        return MIME_BY_EXT[ ext ] || "application/octet-stream";
    }

    function kindOf( mime, name ) {
        const ext = String( name || "" ).split( "." ).pop().toLowerCase();
        if ( mime === "application/pdf" ) { return "pdf"; }
        if ( mime.indexOf( "image/" ) === 0 ) { return "image"; }
        if ( mime.indexOf( "video/" ) === 0 ) { return "video"; }
        if ( mime.indexOf( "audio/" ) === 0 ) { return "audio"; }
        if ( mime === "text/csv" || mime === "text/tab-separated-values" || ext === "csv" || ext === "tsv" ) { return "csv"; }
        if ( mime === "application/json" || ext === "json" ) { return "json"; }
        if ( mime.indexOf( "text/" ) === 0 || /xml|javascript|sql|yaml/.test( mime ) ) { return "text"; }
        return "other";
    }

    const ICONS = { pdf: "fa-file-pdf-o", image: "fa-file-image-o", video: "fa-file-video-o", audio: "fa-file-audio-o", csv: "fa-file-excel-o",
                    json: "fa-file-code-o", text: "fa-file-text-o", other: "fa-file-o" };

    function sizeText( bytes ) {
        if ( bytes === null || bytes === undefined || bytes === "" ) { return ""; }
        const n = Number( bytes ), units = [ "bytes", "KB", "MB", "GB" ];
        let i = 0, v = n;
        while ( v >= 1024 && i < units.length - 1 ) { v /= 1024; i++; }
        return ( i === 0 ? v : v.toFixed( v < 10 ? 1 : 0 ) ) + " " + units[ i ];
    }

    // the plug-in file prefix is relative to the page's <base>; import() needs an absolute URL
    function loadPdfjs( prefix ) {
        if ( !pdfjsPromise ) {
            const base = new URL( prefix, document.baseURI ).href;
            pdfjsPromise = import( base + "pdf.min.mjs" ).then( lib => {
                lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
                return lib;
            } );
        }
        return pdfjsPromise;
    }

    // simple CSV parser with quoted fields; first 1000 rows
    function parseCsv( text, sep ) {
        const rows = [];
        let row = [], field = "", quoted = false;
        for ( let i = 0; i < text.length && rows.length < 1000; i++ ) {
            const c = text[ i ];
            if ( quoted ) {
                if ( c === "\"" && text[ i + 1 ] === "\"" ) { field += "\""; i++; }
                else if ( c === "\"" ) { quoted = false; }
                else { field += c; }
            } else if ( c === "\"" ) { quoted = true; }
            else if ( c === sep ) { row.push( field ); field = ""; }
            else if ( c === "\n" || c === "\r" ) {
                if ( c === "\r" && text[ i + 1 ] === "\n" ) { i++; }
                row.push( field ); rows.push( row ); row = []; field = "";
            } else { field += c; }
        }
        if ( field || row.length ) { row.push( field ); rows.push( row ); }
        return rows;
    }

    function button( action, icon, label ) {
        return "<button type=\"button\" class=\"tx-DocViewer-btn\" data-tx-action=\"" + action + "\" title=\"" + esc( label ) + "\" aria-label=\"" + esc( label ) + "\">" +
            "<span class=\"fa " + icon + "\" aria-hidden=\"true\"></span></button>";
    }

    class Viewer {
        constructor( regionId ) {
            this.regionId = regionId;
            this.el = document.getElementById( regionId + "_viewer" );
            const payload = JSON.parse( document.getElementById( regionId + "_documents" ).textContent );
            this.cfg = payload;
            this.docs = payload.documents || [];
            this.current = null;
            this.zoomMode = payload.initialZoom || "width";
            this.scale = 1;
            this.rotation = 0;
            this.cleanup = [];
            this.build();
            this.renderList();
            const wanted = this.cfg.selectedItem ? apex.item( this.cfg.selectedItem ).getValue() : null;
            const first = this.docs.find( d => String( d.id ) === String( wanted ) ) || this.docs[ 0 ];
            if ( first ) { this.open( first.id, true ); } else { this.empty(); }
        }

        // ---------- frame ----------
        build() {
            const t = this.cfg.toolbar, single = this.cfg.layout === "single";
            this.el.classList.toggle( "tx-DocViewer--single", single );
            this.el.style.setProperty( "--tx-dv-list", ( this.cfg.listWidth || 280 ) + "px" );
            this.el.innerHTML =
                ( single ? "" : "<div class=\"tx-DocViewer-list\" role=\"listbox\" aria-label=\"Documents\" tabindex=\"0\"></div>" ) +
                "<div class=\"tx-DocViewer-main\">" +
                  "<div class=\"tx-DocViewer-toolbar\" role=\"toolbar\" aria-label=\"Document\">" +
                    "<div class=\"tx-DocViewer-group tx-DocViewer-title\"><span class=\"tx-DocViewer-name\"></span></div>" +
                    "<div class=\"tx-DocViewer-group\" data-for=\"pdf\">" +
                      ( has( t, "thumbnails" ) ? button( "thumbs", "fa-columns", "Thumbnails" ) : "" ) +
                      ( has( t, "pages" ) ? button( "prev", "fa-chevron-up", "Previous page" ) +
                        "<label class=\"tx-DocViewer-pageLabel\"><input class=\"tx-DocViewer-page\" type=\"text\" inputmode=\"numeric\" aria-label=\"Page\" value=\"1\"><span class=\"tx-DocViewer-pages\"></span></label>" +
                        button( "next", "fa-chevron-down", "Next page" ) : "" ) +
                    "</div>" +
                    ( has( t, "zoom" ) ? "<div class=\"tx-DocViewer-group\" data-for=\"zoom\">" + button( "zoomOut", "fa-search-minus", "Zoom out" ) +
                        "<button type=\"button\" class=\"tx-DocViewer-btn tx-DocViewer-zoomText\" data-tx-action=\"zoomMode\" title=\"Fit width, fit page or actual size\">100%</button>" +
                        button( "zoomIn", "fa-search-plus", "Zoom in" ) + "</div>" : "" ) +
                    ( has( t, "rotate" ) ? "<div class=\"tx-DocViewer-group\" data-for=\"zoom\">" + button( "rotate", "fa-repeat", "Rotate" ) + "</div>" : "" ) +
                    ( has( t, "search" ) ? "<div class=\"tx-DocViewer-group tx-DocViewer-search\" data-for=\"search\">" +
                        "<span class=\"fa fa-search\" aria-hidden=\"true\"></span><input type=\"search\" placeholder=\"Search\" aria-label=\"Search in document\">" +
                        "<span class=\"tx-DocViewer-hits\" aria-live=\"polite\"></span>" + button( "findPrev", "fa-angle-up", "Previous match" ) + button( "findNext", "fa-angle-down", "Next match" ) + "</div>" : "" ) +
                    "<div class=\"tx-DocViewer-group tx-DocViewer-end\">" +
                      ( has( t, "download" ) ? button( "download", "fa-download", "Download" ) : "" ) +
                      ( has( t, "print" ) ? button( "print", "fa-print", "Print" ) : "" ) +
                      ( has( t, "fullscreen" ) ? button( "fullscreen", "fa-expand", "Full screen" ) : "" ) +
                    "</div>" +
                  "</div>" +
                  "<div class=\"tx-DocViewer-body\"><div class=\"tx-DocViewer-thumbs\" hidden></div><div class=\"tx-DocViewer-stage\" tabindex=\"0\"></div></div>" +
                "</div>";
            this.list = this.el.querySelector( ".tx-DocViewer-list" );
            this.stage = this.el.querySelector( ".tx-DocViewer-stage" );
            this.thumbs = this.el.querySelector( ".tx-DocViewer-thumbs" );
            this.toolbar = this.el.querySelector( ".tx-DocViewer-toolbar" );

            this.toolbar.addEventListener( "click", e => {
                const b = e.target.closest( "[data-tx-action]" );
                if ( b ) { this.action( b.dataset.txAction ); }
            } );
            const page = this.el.querySelector( ".tx-DocViewer-page" );
            if ( page ) {
                page.addEventListener( "change", () => this.goToPage( parseInt( page.value, 10 ) ) );
                page.addEventListener( "keydown", e => { if ( e.key === "Enter" ) { this.goToPage( parseInt( page.value, 10 ) ); } } );
            }
            const search = this.el.querySelector( ".tx-DocViewer-search input" );
            if ( search ) {
                search.addEventListener( "keydown", e => {
                    if ( e.key === "Enter" ) { e.preventDefault(); this.search( search.value, e.shiftKey ? -1 : 1 ); }
                } );
                search.addEventListener( "search", () => { if ( !search.value ) { this.search( "" ); } } );
            }
            if ( this.list ) {
                this.list.addEventListener( "click", e => {
                    const item = e.target.closest( "[data-id]" );
                    if ( item ) { this.open( item.dataset.id ); }
                } );
                this.list.addEventListener( "keydown", e => {
                    if ( [ "ArrowDown", "ArrowUp", "Home", "End" ].indexOf( e.key ) < 0 ) { return; }
                    e.preventDefault();
                    const items = Array.from( this.list.querySelectorAll( "[data-id]" ) ),
                        i = items.findIndex( n => n.getAttribute( "aria-selected" ) === "true" ),
                        next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.max( 0, Math.min( items.length - 1, i + ( e.key === "ArrowDown" ? 1 : -1 ) ) );
                    if ( items[ next ] ) { this.open( items[ next ].dataset.id ); items[ next ].focus(); }
                } );
            }
            // keep the zoom fitting when the region changes size
            let lastWidth = 0;
            new ResizeObserver( () => {
                const w = this.stage.clientWidth;
                if ( Math.abs( w - lastWidth ) > 4 && this.current && this.zoomMode !== "custom" ) {
                    lastWidth = w;
                    if ( this.kind === "pdf" ) { this.layoutPdf(); }
                    if ( this.kind === "image" ) { this.fitImage(); }
                }
            } ).observe( this.stage );
        }

        renderList() {
            if ( !this.list ) { return; }
            if ( !this.docs.length ) {
                this.list.innerHTML = "<p class=\"tx-DocViewer-none\">" + esc( this.cfg.noDataFound || "No documents found." ) + "</p>";
                return;
            }
            this.list.innerHTML = this.docs.map( d => {
                const kind = kindOf( mimeOf( d ), d.n );
                return "<div class=\"tx-DocViewer-item\" role=\"option\" tabindex=\"-1\" aria-selected=\"false\" data-id=\"" + esc( d.id ) + "\">" +
                    "<span class=\"tx-DocViewer-icon tx-DocViewer-icon--" + kind + " fa " + ICONS[ kind ] + "\" aria-hidden=\"true\"></span>" +
                    "<span class=\"tx-DocViewer-itemText\"><span class=\"tx-DocViewer-itemName\">" + esc( d.n ) + "</span>" +
                    "<span class=\"tx-DocViewer-itemMeta\">" + esc( [ sizeText( d.s ), d.i ].filter( Boolean ).join( ", " ) ) + "</span></span></div>";
            } ).join( "" );
        }

        empty() {
            this.toolbar.hidden = true;
            this.stage.innerHTML = "<div class=\"tx-DocViewer-message\">" + esc( this.cfg.noDataFound || "No documents found." ) + "</div>";
        }

        // absolute URLs: PDF.js and fetch() do not resolve against APEX's <base>
        fileUrl( doc, download ) {
            const url = doc.b ? apex.server.pluginUrl( this.cfg.ajaxIdentifier, { x01: "FILE", x02: doc.id, x03: download ? "DOWNLOAD" : "" } ) : doc.u;
            return url ? new URL( url, document.baseURI ).href : "";
        }

        // ---------- open ----------
        open( id, initial ) {
            const doc = this.docs.find( d => String( d.id ) === String( id ) );
            if ( !doc ) { return; }
            this.disposeDocument();
            this.current = doc;
            this.mime = mimeOf( doc );
            this.kind = kindOf( this.mime, doc.n );
            this.rotation = 0;
            this.zoomMode = this.cfg.initialZoom || "width";
            this.toolbar.hidden = false;
            this.el.querySelector( ".tx-DocViewer-name" ).textContent = doc.n;
            this.el.dataset.kind = this.kind;
            if ( this.list ) {
                this.list.querySelectorAll( "[data-id]" ).forEach( n => n.setAttribute( "aria-selected", String( n.dataset.id === String( doc.id ) ) ) );
            }
            if ( this.cfg.selectedItem && !initial ) { apex.item( this.cfg.selectedItem ).setValue( doc.id ); }
            if ( !initial ) { apex.event.trigger( "#" + this.regionId, "tx-docviewer-select", { id: doc.id, name: doc.n, mimeType: this.mime } ); }
            const search = this.el.querySelector( ".tx-DocViewer-search input" );
            if ( search ) { search.value = ""; this.el.querySelector( ".tx-DocViewer-hits" ).textContent = ""; }
            this.thumbs.hidden = true;
            this.stage.scrollTop = 0;
            this.stage.innerHTML = "<div class=\"tx-DocViewer-message\"><span class=\"tx-DocViewer-spinner\" aria-hidden=\"true\"></span>Loading " + esc( doc.n ) + "</div>";
            const url = this.fileUrl( doc );
            if ( !url ) { return this.showFileCard( "This document has no content." ); }
            const done = pages => apex.event.trigger( "#" + this.regionId, "tx-docviewer-load", { id: doc.id, name: doc.n, mimeType: this.mime, pages } );
            const fail = err => {
                // always reported: a document that cannot be shown is something the developer needs to see
                window.console.warn( "Document Viewer: could not open " + doc.n, err );
                this.showFileCard( "This document could not be shown." );
            };
            switch ( this.kind ) {
                case "pdf": this.openPdf( url ).then( done, fail ); break;
                case "image": this.openImage( url ).then( () => done( 1 ), fail ); break;
                case "video":
                case "audio": this.openMedia( url ); done( null ); break;
                case "csv":
                case "json":
                case "text": this.openText( url ).then( () => done( null ), fail ); break;
                default: this.showFileCard( "Preview is not available for this file type." ); done( null );
            }
        }

        disposeDocument() {
            this.cleanup.forEach( f => { try { f(); } catch ( e ) { /* already gone */ } } );
            this.cleanup = [];
            this.pdf = null;
            this.pageViews = [];
            this.matches = [];
        }

        showFileCard( message ) {
            const doc = this.current, kind = this.kind;
            this.stage.innerHTML = "<div class=\"tx-DocViewer-card\">" +
                "<span class=\"tx-DocViewer-cardIcon tx-DocViewer-icon--" + kind + " fa " + ICONS[ kind ] + "\" aria-hidden=\"true\"></span>" +
                "<strong>" + esc( doc.n ) + "</strong><span>" + esc( [ sizeText( doc.s ), this.mime ].filter( Boolean ).join( ", " ) ) + "</span>" +
                "<p>" + esc( message ) + "</p>" +
                ( this.fileUrl( doc ) ? "<a class=\"tx-DocViewer-cardBtn\" href=\"" + esc( this.fileUrl( doc, true ) ) + "\" download=\"" + esc( doc.n ) + "\">" +
                    "<span class=\"fa fa-download\" aria-hidden=\"true\"></span>Download</a>" : "" ) + "</div>";
        }

        // ---------- PDF ----------
        async openPdf( url ) {
            const lib = await loadPdfjs( this.cfg.filePrefix );
            const task = lib.getDocument( { url, withCredentials: true, isEvalSupported: false } );
            this.cleanup.push( () => task.destroy() );
            this.lib = lib;
            this.pdf = await task.promise;
            this.stage.innerHTML = "<div class=\"tx-DocViewer-pagesWrap\"></div>";
            this.pagesWrap = this.stage.firstChild;
            this.pageViews = [];
            const first = await this.pdf.getPage( 1 );
            this.baseViewport = first.getViewport( { scale: 1 } );
            for ( let i = 1; i <= this.pdf.numPages; i++ ) {
                const div = document.createElement( "div" );
                div.className = "tx-DocViewer-pdfPage";
                div.dataset.page = i;
                div.setAttribute( "aria-label", "Page " + i );
                this.pagesWrap.appendChild( div );
                this.pageViews.push( { n: i, div, rendered: null } );
            }
            const pages = this.el.querySelector( ".tx-DocViewer-pages" );
            if ( pages ) { pages.textContent = "of " + this.pdf.numPages; }
            // render pages when they come into view
            this.io = new IntersectionObserver( entries => entries.forEach( e => {
                if ( e.isIntersecting ) { this.renderPage( this.pageViews[ e.target.dataset.page - 1 ] ); }
            } ), { root: this.stage, rootMargin: "400px 0px" } );
            this.pageViews.forEach( v => this.io.observe( v.div ) );
            this.cleanup.push( () => this.io.disconnect() );
            const onScroll = () => this.trackPage();
            this.stage.addEventListener( "scroll", onScroll, { passive: true } );
            this.cleanup.push( () => this.stage.removeEventListener( "scroll", onScroll ) );
            this.layoutPdf();
            return this.pdf.numPages;
        }

        fitScale() {
            const vp = this.baseViewport, rotated = this.rotation % 180 !== 0,
                w = rotated ? vp.height : vp.width, h = rotated ? vp.width : vp.height,
                availW = this.stage.clientWidth - 32, availH = this.stage.clientHeight - 32;
            if ( this.zoomMode === "width" ) { return Math.max( 0.25, availW / w ); }
            if ( this.zoomMode === "page" ) { return Math.max( 0.25, Math.min( availW / w, availH / h ) ); }
            if ( this.zoomMode === "actual" ) { return 1; }
            return this.scale;
        }

        // sizes every page placeholder for the current scale and rotation, then renders the visible ones again
        layoutPdf() {
            if ( !this.pdf ) { return; }
            this.scale = this.fitScale();
            const vp = this.baseViewport.clone( { scale: this.scale, rotation: ( this.baseViewport.rotation + this.rotation ) % 360 } );
            this.pageViews.forEach( v => {
                v.div.style.width = Math.floor( vp.width ) + "px";
                v.div.style.height = Math.floor( vp.height ) + "px";
                v.rendered = null;
                v.div.textContent = "";
            } );
            this.updateZoomText();
            this.pageViews.forEach( v => {
                const r = v.div.getBoundingClientRect(), s = this.stage.getBoundingClientRect();
                if ( r.bottom > s.top - 400 && r.top < s.bottom + 400 ) { this.renderPage( v ); }
            } );
            if ( !this.thumbs.hidden ) { this.renderThumbs(); }
        }

        async renderPage( v ) {
            const key = this.scale + ":" + this.rotation;
            if ( !this.pdf || v.rendered === key ) { return; }
            v.rendered = key;
            const page = await this.pdf.getPage( v.n );
            if ( v.rendered !== key ) { return; }
            // the page and its text layer are drawn unrotated in an inner box that one CSS transform rotates,
            // so the selectable text and the search highlights always sit on the drawn text
            const vp = page.getViewport( { scale: this.scale } ),
                ratio = window.devicePixelRatio || 1,
                inner = document.createElement( "div" ),
                canvas = document.createElement( "canvas" ),
                text = document.createElement( "div" );
            canvas.width = Math.floor( vp.width * ratio );
            canvas.height = Math.floor( vp.height * ratio );
            canvas.style.width = Math.floor( vp.width ) + "px";
            canvas.style.height = Math.floor( vp.height ) + "px";
            text.className = "textLayer";
            inner.className = "tx-DocViewer-pdfInner";
            inner.style.width = Math.floor( vp.width ) + "px";
            inner.style.height = Math.floor( vp.height ) + "px";
            inner.style.transform = { 0: "none", 90: "rotate(90deg) translateY(-100%)", 180: "rotate(180deg) translate(-100%, -100%)", 270: "rotate(270deg) translateX(-100%)" }[ this.rotation ];
            inner.style.setProperty( "--scale-factor", this.scale );
            inner.style.setProperty( "--total-scale-factor", this.scale );
            inner.append( canvas, text );
            v.div.textContent = "";
            v.div.append( inner );
            await page.render( { canvas, canvasContext: canvas.getContext( "2d" ), viewport: vp, transform: ratio !== 1 ? [ ratio, 0, 0, ratio, 0, 0 ] : null } ).promise.catch( () => null );
            if ( v.rendered !== key ) { return; }
            try {
                const layer = new this.lib.TextLayer( { textContentSource: page.streamTextContent(), container: text, viewport: vp } );
                await layer.render();
                this.highlight( v );
            } catch ( e ) {
                apex.debug.info( "Document Viewer: no text layer for page " + v.n );
            }
        }

        trackPage() {
            if ( !this.pageViews || !this.pageViews.length ) { return; }
            const mid = this.stage.getBoundingClientRect().top + this.stage.clientHeight / 3;
            let current = 1;
            this.pageViews.forEach( v => { if ( v.div.getBoundingClientRect().top <= mid ) { current = v.n; } } );
            const input = this.el.querySelector( ".tx-DocViewer-page" );
            if ( input && document.activeElement !== input ) { input.value = current; }
            this.thumbs.querySelectorAll( "[data-page]" ).forEach( t => t.classList.toggle( "is-current", Number( t.dataset.page ) === current ) );
            this.currentPage = current;
        }

        goToPage( n ) {
            if ( !this.pageViews || !this.pageViews.length || !n ) { return; }
            const v = this.pageViews[ Math.max( 1, Math.min( this.pageViews.length, n ) ) - 1 ];
            this.stage.scrollTop = v.div.offsetTop - 16;
        }

        async renderThumbs() {
            if ( !this.pdf ) { return; }
            if ( this.thumbs.childElementCount !== this.pdf.numPages ) {
                this.thumbs.innerHTML = this.pageViews.map( v => "<button type=\"button\" class=\"tx-DocViewer-thumb\" data-page=\"" + v.n + "\" aria-label=\"Page " + v.n + "\"><canvas></canvas><span>" + v.n + "</span></button>" ).join( "" );
                this.thumbs.onclick = e => { const t = e.target.closest( "[data-page]" ); if ( t ) { this.goToPage( Number( t.dataset.page ) ); } };
            }
            const thumbs = Array.from( this.thumbs.querySelectorAll( "canvas" ) );
            for ( let i = 0; i < thumbs.length && i < 200; i++ ) {
                const page = await this.pdf.getPage( i + 1 ), base = page.getViewport( { scale: 1 } ),
                    vp = page.getViewport( { scale: 120 / base.width, rotation: ( base.rotation + this.rotation ) % 360 } );
                thumbs[ i ].width = vp.width;
                thumbs[ i ].height = vp.height;
                await page.render( { canvas: thumbs[ i ], canvasContext: thumbs[ i ].getContext( "2d" ), viewport: vp } ).promise.catch( () => null );
            }
            this.trackPage();
        }

        // ---------- search ----------
        async search( query, direction ) {
            const hits = this.el.querySelector( ".tx-DocViewer-hits" ), q = String( query || "" ).trim().toLowerCase();
            if ( q !== this.lastQuery ) {
                this.lastQuery = q;
                this.matches = [];
                this.matchIndex = -1;
                if ( this.kind === "pdf" && this.pdf && q ) {
                    for ( let i = 1; i <= this.pdf.numPages; i++ ) {
                        const text = ( await ( await this.pdf.getPage( i ) ).getTextContent() ).items.map( t => t.str ).join( " " ).toLowerCase();
                        let at = text.indexOf( q );
                        while ( at > -1 ) { this.matches.push( i ); at = text.indexOf( q, at + q.length ); }
                    }
                } else if ( this.textEl && q ) {
                    this.matches = Array.from( this.textEl.querySelectorAll( "mark" ) );
                }
                this.pageViews && this.pageViews.forEach( v => this.highlight( v ) );
                if ( this.textEl ) { this.markText( q ); this.matches = Array.from( this.textEl.querySelectorAll( "mark" ) ); }
            }
            if ( !q ) { hits.textContent = ""; return; }
            if ( !this.matches.length ) { hits.textContent = "No matches"; return; }
            this.matchIndex = ( this.matchIndex + ( direction || 1 ) + this.matches.length ) % this.matches.length;
            hits.textContent = ( this.matchIndex + 1 ) + " of " + this.matches.length;
            const m = this.matches[ this.matchIndex ];
            if ( typeof m === "number" ) {
                this.goToPage( m );
            } else {
                this.matches.forEach( x => x.classList.remove( "is-current" ) );
                m.classList.add( "is-current" );
                m.scrollIntoView( { block: "center" } );
            }
        }

        highlight( v ) {
            const q = this.lastQuery;
            v.div.querySelectorAll( ".textLayer span" ).forEach( s => {
                s.classList.toggle( "highlight", !!q && s.textContent.toLowerCase().indexOf( q ) > -1 );
            } );
        }

        markText( q ) {
            this.textEl.querySelectorAll( "mark" ).forEach( m => m.replaceWith( document.createTextNode( m.textContent ) ) );
            this.textEl.normalize();
            if ( !q ) { return; }
            const walker = document.createTreeWalker( this.textEl, NodeFilter.SHOW_TEXT ), nodes = [];
            while ( walker.nextNode() ) { nodes.push( walker.currentNode ); }
            nodes.forEach( node => {
                const lower = node.nodeValue.toLowerCase();
                let at = lower.indexOf( q ), rest = node;
                while ( at > -1 && rest ) {
                    const hit = rest.splitText( at ), after = hit.splitText( q.length ), mark = document.createElement( "mark" );
                    hit.replaceWith( mark );
                    mark.appendChild( hit );
                    rest = after;
                    at = rest.nodeValue.toLowerCase().indexOf( q );
                }
            } );
        }

        // ---------- image ----------
        openImage( url ) {
            return new Promise( ( resolve, reject ) => {
                const img = new Image();
                img.className = "tx-DocViewer-image";
                img.alt = this.current.n;
                img.onload = () => {
                    this.stage.innerHTML = "<div class=\"tx-DocViewer-imageWrap\"></div>";
                    this.imageWrap = this.stage.firstChild;
                    this.imageWrap.appendChild( img );
                    this.img = img;
                    this.fitImage();
                    this.enablePan();
                    resolve();
                };
                img.onerror = reject;
                img.src = url;
            } );
        }

        fitImage() {
            if ( !this.img ) { return; }
            const rotated = this.rotation % 180 !== 0,
                w = rotated ? this.img.naturalHeight : this.img.naturalWidth,
                h = rotated ? this.img.naturalWidth : this.img.naturalHeight,
                availW = this.stage.clientWidth - 32, availH = this.stage.clientHeight - 32;
            if ( this.zoomMode === "width" ) { this.scale = Math.min( availW / w, 4 ); }
            else if ( this.zoomMode === "page" ) { this.scale = Math.min( availW / w, availH / h, 4 ); }
            else if ( this.zoomMode === "actual" ) { this.scale = 1; }
            this.imageWrap.style.width = Math.round( w * this.scale ) + "px";
            this.imageWrap.style.height = Math.round( h * this.scale ) + "px";
            this.img.style.width = Math.round( this.img.naturalWidth * this.scale ) + "px";
            this.img.style.transform = "translate(-50%, -50%) rotate(" + this.rotation + "deg)";
            this.updateZoomText();
        }

        enablePan() {
            let start = null;
            const down = e => { if ( e.button === 0 ) { start = { x: e.clientX, y: e.clientY, l: this.stage.scrollLeft, t: this.stage.scrollTop }; this.stage.classList.add( "is-panning" ); } };
            const move = e => { if ( start ) { this.stage.scrollLeft = start.l - ( e.clientX - start.x ); this.stage.scrollTop = start.t - ( e.clientY - start.y ); } };
            const up = () => { start = null; this.stage.classList.remove( "is-panning" ); };
            this.stage.addEventListener( "pointerdown", down );
            window.addEventListener( "pointermove", move );
            window.addEventListener( "pointerup", up );
            this.cleanup.push( () => {
                this.stage.removeEventListener( "pointerdown", down );
                window.removeEventListener( "pointermove", move );
                window.removeEventListener( "pointerup", up );
                this.img = null;
            } );
        }

        // ---------- media and text ----------
        openMedia( url ) {
            const tag = this.kind === "video" ? "video" : "audio";
            this.stage.innerHTML = "<div class=\"tx-DocViewer-media\"><" + tag + " controls preload=\"metadata\" src=\"" + esc( url ) + "\"></" + tag + "></div>";
        }

        async openText( url ) {
            const res = await fetch( url, { credentials: "same-origin" } );
            if ( !res.ok ) { throw new Error( "HTTP " + res.status ); }
            let text = await res.text(), note = "";
            if ( text.length > TEXT_LIMIT ) { text = text.substr( 0, TEXT_LIMIT ); note = "Showing the first 2 MB. Download the file to see all of it."; }
            let html;
            if ( this.kind === "csv" ) {
                const sep = /\.tsv$/i.test( this.current.n ) || this.mime.indexOf( "tab-separated" ) > -1 ? "\t" : ( text.split( "\n" )[ 0 ].split( ";" ).length > text.split( "\n" )[ 0 ].split( "," ).length ? ";" : "," );
                const rows = parseCsv( text, sep );
                html = "<table class=\"tx-DocViewer-table\"><thead><tr>" + ( rows[ 0 ] || [] ).map( c => "<th scope=\"col\">" + esc( c ) + "</th>" ).join( "" ) + "</tr></thead><tbody>" +
                    rows.slice( 1 ).filter( r => r.length > 1 || r[ 0 ] ).map( r => "<tr>" + r.map( c => "<td>" + esc( c ) + "</td>" ).join( "" ) + "</tr>" ).join( "" ) + "</tbody></table>";
                if ( rows.length >= 1000 ) { note = "Showing the first 1,000 rows."; }
            } else {
                if ( this.kind === "json" ) {
                    try { text = JSON.stringify( JSON.parse( text ), null, 2 ); } catch ( e ) { note = "This file is not valid JSON; showing it as text."; }
                }
                html = "<pre class=\"tx-DocViewer-text\">" + esc( text ) + "</pre>";
            }
            this.stage.innerHTML = ( note ? "<p class=\"tx-DocViewer-note\">" + esc( note ) + "</p>" : "" ) + "<div class=\"tx-DocViewer-textWrap\">" + html + "</div>";
            this.textEl = this.stage.querySelector( ".tx-DocViewer-textWrap" );
            this.cleanup.push( () => { this.textEl = null; this.lastQuery = null; } );
        }

        // ---------- toolbar ----------
        updateZoomText() {
            const z = this.el.querySelector( ".tx-DocViewer-zoomText" );
            if ( z ) { z.textContent = Math.round( this.scale * 100 ) + "%"; }
        }

        zoom( factor ) {
            this.zoomMode = "custom";
            this.scale = Math.max( 0.25, Math.min( 5, this.scale * factor ) );
            if ( this.kind === "pdf" ) { this.layoutPdf(); }
            if ( this.kind === "image" ) { this.fitImage(); }
        }

        action( name ) {
            const doc = this.current;
            switch ( name ) {
                case "prev": this.goToPage( ( this.currentPage || 1 ) - 1 ); break;
                case "next": this.goToPage( ( this.currentPage || 1 ) + 1 ); break;
                case "zoomIn": this.zoom( 1.2 ); break;
                case "zoomOut": this.zoom( 1 / 1.2 ); break;
                case "zoomMode": {
                    const order = [ "width", "page", "actual" ];
                    this.zoomMode = order[ ( order.indexOf( this.zoomMode ) + 1 ) % order.length ];
                    if ( this.kind === "pdf" ) { this.layoutPdf(); }
                    if ( this.kind === "image" ) { this.fitImage(); }
                    break;
                }
                case "rotate":
                    this.rotation = ( this.rotation + 90 ) % 360;
                    if ( this.kind === "pdf" ) { this.layoutPdf(); }
                    if ( this.kind === "image" ) { this.fitImage(); }
                    break;
                case "thumbs":
                    this.thumbs.hidden = !this.thumbs.hidden;
                    if ( !this.thumbs.hidden ) { this.renderThumbs(); }
                    if ( this.zoomMode !== "custom" ) { this.layoutPdf(); }
                    break;
                case "findNext":
                case "findPrev": {
                    const input = this.el.querySelector( ".tx-DocViewer-search input" );
                    this.search( input.value, name === "findNext" ? 1 : -1 );
                    break;
                }
                case "download": {
                    const a = document.createElement( "a" );
                    a.href = this.fileUrl( doc, true );
                    a.download = doc.n;
                    document.body.appendChild( a );
                    a.click();
                    a.remove();
                    break;
                }
                case "print": this.print(); break;
                case "fullscreen":
                    if ( document.fullscreenElement ) { document.exitFullscreen(); } else { this.el.requestFullscreen(); }
                    break;
            }
        }

        // prints the file itself through a hidden frame (PDF, image, text); other types open in a new tab
        print() {
            const doc = this.current, url = this.fileUrl( doc );
            if ( [ "pdf", "image", "text", "json", "csv" ].indexOf( this.kind ) < 0 ) { window.open( url, "_blank", "noopener" ); return; }
            const frame = document.createElement( "iframe" );
            frame.className = "tx-DocViewer-printFrame";
            frame.title = "Print";
            frame.onload = () => {
                try {
                    frame.contentWindow.focus();
                    frame.contentWindow.print();
                } catch ( e ) {
                    window.open( url, "_blank", "noopener" );
                }
                setTimeout( () => frame.remove(), 60000 );
            };
            frame.src = url;
            document.body.appendChild( frame );
        }

        refresh() {
            return apex.server.plugin( this.cfg.ajaxIdentifier, { x01: "LIST", pageItems: this.cfg.itemsToSubmit }, {
                refreshObject: "#" + this.regionId,
                loadingIndicator: this.el,
                loadingIndicatorPosition: "centered"
            } ).done( data => {
                const openId = this.current && this.current.id;
                this.docs = data.documents || [];
                this.renderList();
                const keep = this.docs.find( d => String( d.id ) === String( openId ) );
                if ( keep ) {
                    this.list && this.list.querySelectorAll( "[data-id]" ).forEach( n => n.setAttribute( "aria-selected", String( n.dataset.id === String( openId ) ) ) );
                } else if ( this.docs.length ) {
                    this.open( this.docs[ 0 ].id );
                } else {
                    this.disposeDocument();
                    this.current = null;
                    this.empty();
                }
            } );
        }
    }

    const viewers = {};
    ns.documentViewer = {
        init( regionId ) {
            const viewer = new Viewer( regionId );
            viewers[ regionId ] = viewer;
            apex.region.create( regionId, {
                type: "TechRevXDocumentViewer",
                refresh: () => viewer.refresh(),
                open: id => viewer.open( id ),
                widget: () => $( viewer.el )
            } );
        },
        get: regionId => viewers[ regionId ]
    };
} )( apex.jQuery, apex );
