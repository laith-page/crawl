package crawler;

import ai.l3.cli.BlockWriter;
import java.util.List;

record Page(String url, int status, Failure failure, List<String> links) {

    static Page response(String url, int status, List<String> links) {
        return new Page(url, status, null, links);
    }

    static Page failed(String url, int status, Failure failure) {
        return new Page(url, failure.hidesStatus() ? 0 : status, failure, List.of());
    }

    boolean isFailure() {
        return failure != null;
    }

    boolean unreachable() {
        return failure != null && failure.isUnreachable();
    }

    /** Writes the page's line of the contract: its URL, its status and its error, when it has them. */
    void writeTo(BlockWriter out) {
        out.ascii(url);
        if (status != 0) out.ascii(' ').decimal(status);
        if (failure != null) out.ascii(" error: ").ascii(failure.label());
        out.endLine();
    }
}
