package crawler;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The URL form over fixtures/urls.json, the corpus every engine resolves: one row, one printed URL or none. */
class UrlsTest {

    private static final Path CORPUS_FILE = Path.of("fixtures", "urls.json");

    /** A row of the corpus: the page (null for the command line), the href, the URL wanted (null for no link). */
    private record Row(String base, String href, String want) {}

    @Test
    void resolvesEveryRowOfTheCorpusAsTheFormSays() throws IOException {
        List<Row> rows = corpus();
        assertTrue(rows.size() > 100, "the corpus has rows");
        List<String> wrong = new ArrayList<>();
        for (Row row : rows) {
            String got = row.base() == null ? Urls.startUrl(row.href()) : Urls.resolve(row.base(), row.href());
            if (!java.util.Objects.equals(row.want(), got)) {
                wrong.add(row.base() + " + " + row.href().strip() + ": want " + row.want() + ", got " + got);
            }
        }
        assertEquals(List.of(), wrong, wrong.size() + " rows differ");
    }

    /** fixtures/urls.json, read with a reader for exactly its shape: an array of flat objects of strings and nulls. */
    private static List<Row> corpus() throws IOException {
        String json = Files.readString(CORPUS_FILE);
        List<Row> rows = new ArrayList<>();
        int[] at = {0};
        skipSpace(json, at);
        expect(json, at, '[');
        while (true) {
            skipSpace(json, at);
            if (json.charAt(at[0]) == ']') break;
            String base = null, href = null, want = null;
            expect(json, at, '{');
            while (true) {
                skipSpace(json, at);
                String key = string(json, at);
                skipSpace(json, at);
                expect(json, at, ':');
                skipSpace(json, at);
                String value = null;
                if (json.startsWith("null", at[0])) at[0] += 4;
                else value = string(json, at);
                switch (key) {
                    case "base" -> base = value;
                    case "href" -> href = value;
                    case "want" -> want = value;
                    default -> {}
                }
                skipSpace(json, at);
                if (json.charAt(at[0]) == '}') break;
                expect(json, at, ',');
            }
            at[0]++;
            rows.add(new Row(base, href, want));
            skipSpace(json, at);
            if (json.charAt(at[0]) == ',') at[0]++;
        }
        return rows;
    }

    private static void skipSpace(String json, int[] at) {
        while (Character.isWhitespace(json.charAt(at[0]))) at[0]++;
    }

    private static void expect(String json, int[] at, char c) {
        if (json.charAt(at[0]) != c) throw new IllegalStateException("expected " + c + " at " + at[0]);
        at[0]++;
    }

    private static String string(String json, int[] at) {
        expect(json, at, '"');
        StringBuilder out = new StringBuilder();
        while (json.charAt(at[0]) != '"') {
            char c = json.charAt(at[0]++);
            if (c != '\\') {
                out.append(c);
                continue;
            }
            char escape = json.charAt(at[0]++);
            switch (escape) {
                case 'n' -> out.append('\n');
                case 't' -> out.append('\t');
                case 'r' -> out.append('\r');
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'u' -> {
                    out.append((char) Integer.parseInt(json.substring(at[0], at[0] + 4), 16));
                    at[0] += 4;
                }
                default -> out.append(escape);
            }
        }
        at[0]++;
        return out.toString();
    }
}
