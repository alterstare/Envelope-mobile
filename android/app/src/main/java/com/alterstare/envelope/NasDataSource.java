package com.alterstare.envelope;

import android.content.Context;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSourceException;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

// Audio on a NAS for ExoPlayer: "envnas://f/nas/<conn>/<path>" read through Vfs
// (SMB or WebDAV, whichever the connection uses now) from any byte offset, so
// seeking works. Phone files go to Media3's own DefaultDataSource.
@UnstableApi
final class NasDataSource extends BaseDataSource {
    static final String SCHEME = "envnas";
    private static final Map<String, Long> sizes = new ConcurrentHashMap<>();

    private InputStream in;
    private Uri uri;
    private long left;
    private boolean opened;

    NasDataSource() {
        super(true);
    }

    static Uri uriOf(String path) {
        return new Uri.Builder().scheme(SCHEME).authority("f").path(path).build();
    }

    @Override
    public long open(@NonNull DataSpec spec) throws IOException {
        uri = spec.uri;
        String path = uri.getPath();
        if (path == null) throw new DataSourceException(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND);
        transferInitializing(spec);
        Long size = sizes.get(path);
        if (size == null) {
            RemoteFs.Entry e = Vfs.stat(path);
            if (!e.exists) throw new DataSourceException(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND);
            size = e.size;
            sizes.put(path, size);
        }
        if (spec.position > size) throw new DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE);
        try {
            in = Vfs.openAt(path, spec.position);
        } catch (IOException e) {
            sizes.remove(path);
            throw new DataSourceException(e, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED);
        }
        left = spec.length != C.LENGTH_UNSET ? spec.length : size - spec.position;
        opened = true;
        transferStarted(spec);
        return left;
    }

    @Override
    public int read(@NonNull byte[] buf, int off, int len) throws IOException {
        if (len == 0) return 0;
        if (left == 0) return C.RESULT_END_OF_INPUT;
        int n;
        try {
            n = in.read(buf, off, (int) Math.min(len, left));
        } catch (IOException e) {
            throw new DataSourceException(e, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED);
        }
        if (n < 0) return C.RESULT_END_OF_INPUT;
        left -= n;
        bytesTransferred(n);
        return n;
    }

    @Nullable
    @Override
    public Uri getUri() {
        return uri;
    }

    @Override
    public void close() throws IOException {
        uri = null;
        try {
            if (in != null) in.close();
        } finally {
            in = null;
            if (opened) {
                opened = false;
                transferEnded();
            }
        }
    }

    // Picks the NAS reader or Media3's own (phone files) by the uri's scheme.
    static final class Routing implements DataSource {
        private final DataSource local;
        private final NasDataSource nas = new NasDataSource();
        private DataSource cur;

        Routing(Context ctx) {
            local = new DefaultDataSource.Factory(ctx).createDataSource();
        }

        @Override
        public void addTransferListener(@NonNull TransferListener l) {
            local.addTransferListener(l);
            nas.addTransferListener(l);
        }

        @Override
        public long open(@NonNull DataSpec spec) throws IOException {
            cur = SCHEME.equals(spec.uri.getScheme()) ? nas : local;
            return cur.open(spec);
        }

        @Override
        public int read(@NonNull byte[] buf, int off, int len) throws IOException {
            return cur.read(buf, off, len);
        }

        @Nullable
        @Override
        public Uri getUri() {
            return cur == null ? null : cur.getUri();
        }

        @Override
        public void close() throws IOException {
            if (cur != null) {
                try {
                    cur.close();
                } finally {
                    cur = null;
                }
            }
        }
    }
}
