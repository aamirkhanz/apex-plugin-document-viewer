-- Document Viewer region plug-in (TechRevX, www.techrevx.com)
-- render: writes the viewer container and a JSON block with the settings and the document list
--         (no file contents), then calls techrevx.documentViewer.init (document-viewer.js).
-- ajax:   x01 = LIST     returns the document list again (refresh)
--         x01 = FILE     streams the file of the row whose ID is x02; x03 = DOWNLOAD sends it as an attachment.
--         Only rows of the region's own source can be served.
-- List rows: id, n (name), m (mime type), s (size), i (description), u (url), b (has content: true).

c_column_attrs constant apex_t_varchar2 := apex_t_varchar2(
    'ID_COLUMN', 'NAME_COLUMN', 'MIME_COLUMN', 'CONTENT_COLUMN', 'URL_COLUMN', 'SIZE_COLUMN', 'INFO_COLUMN' );

type t_query is record (
    context apex_exec.t_context,
    pos     apex_t_number );

function info_text( p_context in apex_exec.t_context, p_pos in pls_integer ) return varchar2 is
    l_type pls_integer := apex_exec.get_column( p_context, p_pos ).data_type;
begin
    return case
               when l_type = apex_exec.c_data_type_date then to_char( apex_exec.get_date( p_context, p_pos ), 'YYYY-MM-DD HH24:MI' )
               when l_type in ( apex_exec.c_data_type_timestamp, apex_exec.c_data_type_timestamp_tz, apex_exec.c_data_type_timestamp_ltz )
                   then to_char( cast( apex_exec.get_timestamp( p_context, p_pos ) as date ), 'YYYY-MM-DD HH24:MI' )
               else apex_exec.get_varchar2( p_context, p_pos )
           end;
end info_text;

-- opens the region source with the mapped columns; pos( i ) is the position of c_column_attrs( i )
function open_query( p_region in apex_plugin.t_region ) return t_query is
    l_names   apex_t_varchar2 := apex_t_varchar2();
    l_columns apex_exec.t_columns;
    l_query   t_query;
    l_added   boolean;
begin
    l_names.extend( c_column_attrs.count );
    l_query.pos := apex_t_number();
    l_query.pos.extend( c_column_attrs.count );
    for i in 1 .. c_column_attrs.count loop
        l_names( i ) := p_region.attributes.get_varchar2( c_column_attrs( i ) );
        if l_names( i ) is not null then
            l_added := false;
            for j in 1 .. i - 1 loop
                l_added := l_added or nvl( l_names( j ) = l_names( i ), false );
            end loop;
            if not l_added then
                -- add_column assumes VARCHAR2 unless told otherwise
                apex_exec.add_column(
                    p_columns     => l_columns,
                    p_column_name => l_names( i ),
                    p_data_type   => case when c_column_attrs( i ) = 'CONTENT_COLUMN' then apex_exec.c_data_type_blob end );
            end if;
        end if;
    end loop;

    l_query.context := apex_exec.open_query_context( p_columns => l_columns, p_max_rows => 2000 );
    for i in 1 .. c_column_attrs.count loop
        if l_names( i ) is not null then
            l_query.pos( i ) := case
                                    when c_column_attrs( i ) = 'CONTENT_COLUMN'
                                        then apex_exec.get_column_position( l_query.context, l_names( i ), p_data_type => apex_exec.c_data_type_blob )
                                    else apex_exec.get_column_position( l_query.context, l_names( i ) )
                                end;
            if l_query.pos( i ) is null then
                raise_application_error( -20001, 'Document Viewer: column ' || l_names( i ) || ' is not in the region source of "' || p_region.name || '".' );
            end if;
        end if;
    end loop;
    return l_query;
end open_query;

procedure write_list( p_region in apex_plugin.t_region ) is
    l_query t_query;
    l_blob  blob;
    l_size  number;
begin
    l_query := open_query( p_region );
    apex_json.open_array( 'documents' );
    while apex_exec.next_row( l_query.context ) loop
        apex_json.open_object;
        apex_json.write( 'id', apex_exec.get_varchar2( l_query.context, l_query.pos( 1 ) ) );
        apex_json.write( 'n', apex_exec.get_varchar2( l_query.context, l_query.pos( 2 ) ) );
        if l_query.pos( 3 ) is not null then
            apex_json.write( 'm', apex_exec.get_varchar2( l_query.context, l_query.pos( 3 ) ) );
        end if;
        l_size := null;
        if l_query.pos( 4 ) is not null then
            l_blob := apex_exec.get_blob( l_query.context, l_query.pos( 4 ) );
            if l_blob is not null and dbms_lob.getlength( l_blob ) > 0 then
                apex_json.write( 'b', true );
                l_size := dbms_lob.getlength( l_blob );
            end if;
        end if;
        if l_query.pos( 5 ) is not null then
            apex_json.write( 'u', apex_plugin_util.replace_substitutions( apex_exec.get_varchar2( l_query.context, l_query.pos( 5 ) ), false ) );
        end if;
        if l_query.pos( 6 ) is not null then
            l_size := nvl( apex_exec.get_number( l_query.context, l_query.pos( 6 ) ), l_size );
        end if;
        apex_json.write( 's', l_size );
        if l_query.pos( 7 ) is not null then
            apex_json.write( 'i', info_text( l_query.context, l_query.pos( 7 ) ) );
        end if;
        apex_json.close_object;
    end loop;
    apex_json.close_array;
    apex_exec.close( l_query.context );
exception
    when others then
        apex_exec.close( l_query.context );
        raise;
end write_list;

-- streams the content of the row whose ID is p_id; only rows of the region source qualify
procedure send_file( p_region in apex_plugin.t_region, p_id in varchar2, p_download in boolean ) is
    l_query t_query;
    l_blob  blob;
    l_name  varchar2(4000);
    l_mime  varchar2(255);
    l_found boolean := false;
begin
    if p_region.attributes.get_varchar2( 'CONTENT_COLUMN' ) is null then
        raise_application_error( -20002, 'Document Viewer: no Content Column.' );
    end if;
    l_query := open_query( p_region );
    while not l_found and apex_exec.next_row( l_query.context ) loop
        if apex_exec.get_varchar2( l_query.context, l_query.pos( 1 ) ) = p_id then
            l_found := true;
            l_blob  := apex_exec.get_blob( l_query.context, l_query.pos( 4 ) );
            l_name  := apex_exec.get_varchar2( l_query.context, l_query.pos( 2 ) );
            if l_query.pos( 3 ) is not null then
                l_mime := apex_exec.get_varchar2( l_query.context, l_query.pos( 3 ) );
            end if;
        end if;
    end loop;

    if not l_found or l_blob is null then
        apex_exec.close( l_query.context );
        sys.owa_util.status_line( 404, 'Not Found', false );
        sys.owa_util.http_header_close;
        apex_application.stop_apex_engine;
    end if;

    sys.htp.init;
    sys.owa_util.mime_header( nvl( l_mime, 'application/octet-stream' ), false );
    sys.htp.p( 'Content-Length: ' || dbms_lob.getlength( l_blob ) );
    sys.htp.p( 'Content-Disposition: ' || case when p_download then 'attachment' else 'inline' end
               || '; filename="' || regexp_replace( l_name, '["\\' || chr(10) || chr(13) || ']', '_' ) || '"'
               || '; filename*=UTF-8''''' || utl_url.escape( l_name, true, 'AL32UTF8' ) );
    sys.htp.p( 'X-Content-Type-Options: nosniff' );
    sys.htp.p( 'Cache-Control: private, max-age=300' );
    sys.owa_util.http_header_close;
    sys.wpg_docload.download_file( l_blob );
    apex_exec.close( l_query.context );
    apex_application.stop_apex_engine;
exception
    when apex_application.e_stop_apex_engine then
        raise;
    when others then
        apex_exec.close( l_query.context );
        raise;
end send_file;

procedure render (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_render_param,
    p_result in out nocopy apex_plugin.t_region_render_result )
is
    l_json clob;
begin
    apex_json.initialize_clob_output;
    apex_json.open_object;
    apex_json.write( 'ajaxIdentifier', apex_plugin.get_ajax_identifier );
    apex_json.write( 'itemsToSubmit', apex_plugin_util.page_item_names_to_jquery( p_region.ajax_items_to_submit ) );
    apex_json.write( 'noDataFound', apex_plugin_util.replace_substitutions( p_region.no_data_found_message, false ) );
    apex_json.write( 'filePrefix', p_plugin.file_prefix );
    apex_json.write( 'layout', p_region.attributes.get_varchar2( 'LAYOUT' ) );
    apex_json.write( 'height', p_region.attributes.get_number( 'HEIGHT' ) );
    apex_json.write( 'listWidth', p_region.attributes.get_number( 'LIST_WIDTH' ) );
    apex_json.write( 'toolbar', p_region.attributes.get_varchar2( 'TOOLBAR' ) );
    apex_json.write( 'initialZoom', p_region.attributes.get_varchar2( 'INITIAL_ZOOM' ) );
    apex_json.write( 'selectedItem', p_region.attributes.get_varchar2( 'SELECTED_ITEM' ) );
    write_list( p_region );
    apex_json.close_object;
    l_json := apex_json.get_clob_output;
    apex_json.free_output;

    sys.htp.p( '<div id="' || apex_escape.html_attribute( p_region.static_id ) || '_viewer" class="tx-DocViewer" style="height:'
               || nvl( p_region.attributes.get_number( 'HEIGHT' ), 640 ) || 'px"></div>' );
    sys.htp.p( '<script type="application/json" id="' || apex_escape.html_attribute( p_region.static_id ) || '_documents">' );
    apex_util.prn( p_clob => replace( l_json, '</', '<\/' ), p_escape => false );
    sys.htp.p( '</script>' );
    dbms_lob.freetemporary( l_json );

    apex_javascript.add_onload_code(
        p_code => 'techrevx.documentViewer.init(' || apex_javascript.add_value( p_region.static_id, false ) || ');' );
end render;

procedure ajax (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_ajax_param,
    p_result in out nocopy apex_plugin.t_region_ajax_result )
is
begin
    if apex_application.g_x01 = 'FILE' then
        send_file( p_region, apex_application.g_x02, apex_application.g_x03 = 'DOWNLOAD' );
    else
        apex_json.open_object;
        write_list( p_region );
        apex_json.close_object;
    end if;
end ajax;
