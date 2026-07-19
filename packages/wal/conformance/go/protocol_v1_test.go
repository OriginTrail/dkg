package protocolv1_test

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"testing"

	"github.com/zeebo/blake3"
)

var domains = map[string][]byte{
	"seed":      []byte("dkg-wal-iblt-seed-v1\x00"),
	"mapping":   []byte("dkg-wal-iblt-map-v1\x00"),
	"checksum":  []byte("dkg-wal-iblt-check-v1\x00"),
	"setEmpty":  []byte("dkg-wal-set-empty-v1\x00"),
	"setLeaf":   []byte("dkg-wal-set-leaf-v1\x00"),
	"setBranch": []byte("dkg-wal-set-branch-v1\x00"),
}

type vectorSymbol struct {
	SymbolIndex   int    `json:"symbolIndex"`
	Count         string `json:"count"`
	IDXor         string `json:"idXor"`
	ChecksumXor   string `json:"checksumXor"`
	CanonicalCBOR string `json:"canonicalCbor"`
}

type vectorTrace struct {
	SymbolIndex int    `json:"symbolIndex"`
	Outcome     string `json:"outcome"`
	IDHex       string `json:"idHex,omitempty"`
}

type vectorFile struct {
	Schema             string   `json:"schema"`
	RequesterHeadID    string   `json:"requesterHeadId"`
	ProviderHeadID     string   `json:"providerHeadId"`
	RequesterNonce     string   `json:"requesterNonce"`
	ReconciliationSeed string   `json:"reconciliationSeed"`
	ReceiverIDs        []string `json:"receiverIds"`
	ProviderIDs        []string `json:"providerIds"`
	ReceiverRoot       string   `json:"receiverRoot"`
	ProviderRoot       string   `json:"providerRoot"`
	CommitmentCases    []struct {
		Name string   `json:"name"`
		IDs  []string `json:"ids"`
		Root string   `json:"root"`
	} `json:"commitmentCases"`
	MappingCase struct {
		ID      string `json:"id"`
		Indices []int  `json:"indices"`
	} `json:"mappingCase"`
	Symbols           []vectorSymbol `json:"symbols"`
	SubtractionStates []struct {
		AfterSymbol int            `json:"afterSymbol"`
		Residual    []vectorSymbol `json:"residual"`
	} `json:"subtractionStates"`
	Decode struct {
		Complete     bool          `json:"complete"`
		ProviderOnly []string      `json:"providerOnly"`
		ReceiverOnly []string      `json:"receiverOnly"`
		PeelTrace    []vectorTrace `json:"peelTrace"`
	} `json:"decode"`
	FailureCases []struct {
		Name          string `json:"name"`
		CanonicalCBOR string `json:"canonicalCbor"`
		ExpectedCode  string `json:"expectedCode"`
	} `json:"failureCases"`
	FallbackPages []struct {
		HeadID string   `json:"headId"`
		Offset int      `json:"offset"`
		Done   bool     `json:"done"`
		IDs    []string `json:"ids"`
	} `json:"fallbackPages"`
}

type symbol struct {
	index       int
	count       int64
	idXor       [32]byte
	checksumXor [32]byte
}

type mappingCursor struct {
	state uint64
	last  int
}

type commitmentNode struct {
	count int
	hash  [32]byte
}

func digest(values ...[]byte) [32]byte {
	hasher := blake3.New()
	for _, value := range values {
		_, _ = hasher.Write(value)
	}
	var output [32]byte
	copy(output[:], hasher.Sum(nil))
	return output
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatalf("invalid vector hex: %v", err)
	}
	return decoded
}

func hexIDs(t *testing.T, values []string) [][]byte {
	t.Helper()
	result := make([][]byte, len(values))
	for index, value := range values {
		result[index] = mustHex(t, value)
		if len(result[index]) != 32 {
			t.Fatalf("ID %d is not bytes32", index)
		}
	}
	return result
}

func u64be(value uint64) []byte {
	output := make([]byte, 8)
	binary.BigEndian.PutUint64(output, value)
	return output
}

func nibbleAt(id []byte, depth int) byte {
	if depth%2 == 0 {
		return id[depth/2] >> 4
	}
	return id[depth/2] & 0x0f
}

func packPrefix(prefix []byte) []byte {
	output := make([]byte, (len(prefix)+1)/2)
	for index, nibble := range prefix {
		if index%2 == 0 {
			output[index/2] = nibble << 4
		} else {
			output[index/2] |= nibble
		}
	}
	return output
}

func buildCommitment(ids [][]byte, prefix []byte) commitmentNode {
	if len(ids) <= 256 {
		parts := [][]byte{domains["setLeaf"], {byte(len(prefix))}, packPrefix(prefix), u64be(uint64(len(ids)))}
		parts = append(parts, ids...)
		return commitmentNode{count: len(ids), hash: digest(parts...)}
	}
	groups := make([][][]byte, 16)
	for _, id := range ids {
		groups[nibbleAt(id, len(prefix))] = append(groups[nibbleAt(id, len(prefix))], id)
	}
	bitmap := uint16(0)
	parts := [][]byte{domains["setBranch"], {byte(len(prefix))}, packPrefix(prefix)}
	children := make([]commitmentNode, 16)
	for nibble, group := range groups {
		if len(group) == 0 {
			continue
		}
		bitmap |= 1 << nibble
		childPrefix := append(append([]byte{}, prefix...), byte(nibble))
		children[nibble] = buildCommitment(group, childPrefix)
	}
	bitmapBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(bitmapBytes, bitmap)
	parts = append(parts, bitmapBytes)
	for nibble, child := range children {
		if child.count == 0 {
			continue
		}
		parts = append(parts, []byte{byte(nibble)}, u64be(uint64(child.count)), child.hash[:])
	}
	return commitmentNode{count: len(ids), hash: digest(parts...)}
}

func setCommitment(ids [][]byte) [32]byte {
	if len(ids) == 0 {
		return digest(domains["setEmpty"])
	}
	copied := append([][]byte{}, ids...)
	sort.Slice(copied, func(i, j int) bool { return bytes.Compare(copied[i], copied[j]) < 0 })
	return buildCommitment(copied, nil).hash
}

func checksum(seed, id []byte) [32]byte { return digest(domains["checksum"], seed, id) }

func mappingSeed(seed, id []byte) uint64 {
	value := digest(domains["mapping"], seed, id)
	return binary.LittleEndian.Uint64(value[:8])
}

func nextMapping(cursor *mappingCursor) int {
	cursor.state *= 0xda942042e4dd58b5
	inverseSqrt := float64(uint64(1)<<32) / math.Sqrt(float64(cursor.state)+1)
	distance := int(math.Ceil((float64(cursor.last) + 1.5) * (inverseSqrt - 1)))
	if distance < 1 {
		distance = 1
	}
	cursor.last += distance
	return cursor.last
}

func xor32(target *[32]byte, value []byte) {
	for index := range target {
		target[index] ^= value[index]
	}
}

func apply(target *symbol, id, check []byte, direction int64) {
	target.count += direction
	xor32(&target.idXor, id)
	xor32(&target.checksumXor, check)
}

func generateSymbols(ids [][]byte, seed []byte, count int) []symbol {
	type entry struct {
		id     []byte
		check  [32]byte
		cursor mappingCursor
		next   int
	}
	sorted := append([][]byte{}, ids...)
	sort.Slice(sorted, func(i, j int) bool { return bytes.Compare(sorted[i], sorted[j]) < 0 })
	entries := make([]entry, len(sorted))
	for index, id := range sorted {
		entries[index] = entry{id: id, check: checksum(seed, id), cursor: mappingCursor{state: mappingSeed(seed, id)}}
	}
	output := make([]symbol, count)
	for symbolIndex := range output {
		output[symbolIndex].index = symbolIndex
		for entryIndex := range entries {
			current := &entries[entryIndex]
			if current.next != symbolIndex {
				continue
			}
			apply(&output[symbolIndex], current.id, current.check[:], 1)
			current.next = nextMapping(&current.cursor)
		}
	}
	return output
}

func appendMajor(output []byte, major byte, value uint64) []byte {
	switch {
	case value < 24:
		return append(output, major<<5|byte(value))
	case value <= math.MaxUint8:
		return append(output, major<<5|24, byte(value))
	case value <= math.MaxUint16:
		return append(output, major<<5|25, byte(value>>8), byte(value))
	case value <= math.MaxUint32:
		return append(output, major<<5|26, byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
	default:
		buffer := make([]byte, 9)
		buffer[0] = major<<5 | 27
		binary.BigEndian.PutUint64(buffer[1:], value)
		return append(output, buffer...)
	}
}

func canonicalCBOR(value symbol) []byte {
	output := []byte{0x84}
	output = appendMajor(output, 0, uint64(value.index))
	if value.count >= 0 {
		output = appendMajor(output, 0, uint64(value.count))
	} else {
		output = appendMajor(output, 1, uint64(-1-value.count))
	}
	output = append(output, 0x58, 0x20)
	output = append(output, value.idXor[:]...)
	output = append(output, 0x58, 0x20)
	return append(output, value.checksumXor[:]...)
}

func isZero(value symbol) bool {
	return value.count == 0 && value.idXor == [32]byte{} && value.checksumXor == [32]byte{}
}

func pure(value symbol, seed []byte) (bool, []byte) {
	if value.count != 1 && value.count != -1 {
		return false, nil
	}
	id := append([]byte{}, value.idXor[:]...)
	check := checksum(seed, id)
	return bytes.Equal(check[:], value.checksumXor[:]), id
}

func mappedIndices(seed, id []byte, limit int) []int {
	indices := []int{}
	cursor := mappingCursor{state: mappingSeed(seed, id)}
	for index := 0; index < limit; index = nextMapping(&cursor) {
		indices = append(indices, index)
	}
	return indices
}

func isMemberAt(seed, id []byte, symbolIndex int) bool {
	indices := mappedIndices(seed, id, symbolIndex+1)
	return len(indices) > 0 && indices[len(indices)-1] == symbolIndex
}

func applyToMappedCells(cells []symbol, seed, id []byte, direction int64) []int {
	check := checksum(seed, id)
	indices := mappedIndices(seed, id, len(cells))
	for _, index := range indices {
		apply(&cells[index], id, check[:], direction)
	}
	return indices
}

type decodedID struct {
	id         []byte
	correction int64
}

type incrementalDecoder struct {
	seed         []byte
	cells        []symbol
	decoded      []bool
	seen         map[string]bool
	known        []decodedID
	providerOnly []string
	receiverOnly []string
	trace        []vectorTrace
}

func newIncrementalDecoder(seed []byte) *incrementalDecoder {
	return &incrementalDecoder{seed: seed, seen: map[string]bool{}}
}

func subtract(provider, receiver symbol) symbol {
	result := provider
	result.count -= receiver.count
	xor32(&result.idXor, receiver.idXor[:])
	xor32(&result.checksumXor, receiver.checksumXor[:])
	return result
}

func queueIfDecodable(queue map[int]bool, index int, cell symbol, seed []byte, includeZero bool) {
	valid, _ := pure(cell, seed)
	if valid || (includeZero && isZero(cell)) {
		queue[index] = true
	}
}

func takeMinimum(queue map[int]bool) int {
	minimum := math.MaxInt
	for index := range queue {
		if index < minimum {
			minimum = index
		}
	}
	delete(queue, minimum)
	return minimum
}

func (decoder *incrementalDecoder) add(provider, receiver symbol) bool {
	residual := subtract(provider, receiver)
	for _, known := range decoder.known {
		if isMemberAt(decoder.seed, known.id, residual.index) {
			check := checksum(decoder.seed, known.id)
			apply(&residual, known.id, check[:], known.correction)
		}
	}
	decoder.cells = append(decoder.cells, residual)
	decoder.decoded = append(decoder.decoded, false)
	queue := map[int]bool{}
	queueIfDecodable(queue, residual.index, residual, decoder.seed, true)
	for len(queue) > 0 {
		index := takeMinimum(queue)
		cell := decoder.cells[index]
		if isZero(cell) {
			decoder.decoded[index] = true
			decoder.trace = append(decoder.trace, vectorTrace{SymbolIndex: index, Outcome: "zero"})
			continue
		}
		valid, id := pure(cell, decoder.seed)
		if !valid {
			return false
		}
		idHex := hex.EncodeToString(id)
		if decoder.seen[idHex] {
			return false
		}
		decoder.seen[idHex] = true
		correction := int64(-1)
		outcome := "provider-only"
		if cell.count == -1 {
			correction = 1
			outcome = "receiver-only"
			decoder.receiverOnly = append(decoder.receiverOnly, idHex)
		} else {
			decoder.providerOnly = append(decoder.providerOnly, idHex)
		}
		for _, affected := range applyToMappedCells(decoder.cells, decoder.seed, id, correction) {
			queueIfDecodable(queue, affected, decoder.cells[affected], decoder.seed, false)
		}
		decoder.known = append(decoder.known, decodedID{id: id, correction: correction})
		decoder.decoded[index] = true
		decoder.trace = append(decoder.trace, vectorTrace{SymbolIndex: index, Outcome: outcome, IDHex: idHex})
	}
	return true
}

func (decoder *incrementalDecoder) complete() bool {
	if len(decoder.cells) == 0 {
		return false
	}
	for index, cell := range decoder.cells {
		if !decoder.decoded[index] || !isZero(cell) {
			return false
		}
	}
	return true
}

func matchesVectorSymbol(actual symbol, expected vectorSymbol) bool {
	count, err := strconv.ParseInt(expected.Count, 10, 64)
	return err == nil &&
		actual.index == expected.SymbolIndex &&
		actual.count == count &&
		hex.EncodeToString(actual.idXor[:]) == expected.IDXor &&
		hex.EncodeToString(actual.checksumXor[:]) == expected.ChecksumXor &&
		hex.EncodeToString(canonicalCBOR(actual)) == expected.CanonicalCBOR
}

type cborReader struct {
	bytes  []byte
	offset int
}

func (reader *cborReader) readByte() (byte, bool) {
	if reader.offset >= len(reader.bytes) {
		return 0, false
	}
	value := reader.bytes[reader.offset]
	reader.offset++
	return value, true
}

func (reader *cborReader) readExact(length int) ([]byte, bool) {
	if length < 0 || reader.offset+length > len(reader.bytes) {
		return nil, false
	}
	value := reader.bytes[reader.offset : reader.offset+length]
	reader.offset += length
	return value, true
}

func (reader *cborReader) readUnsigned(additional byte) (uint64, string) {
	if additional < 24 {
		return uint64(additional), ""
	}
	lengths := map[byte]int{24: 1, 25: 2, 26: 4, 27: 8}
	length, exists := lengths[additional]
	if !exists {
		return 0, "MALFORMED_SYMBOL"
	}
	encoded, ok := reader.readExact(length)
	if !ok {
		return 0, "MALFORMED_SYMBOL"
	}
	var value uint64
	for _, part := range encoded {
		value = value<<8 | uint64(part)
	}
	minimums := map[int]uint64{1: 24, 2: 0x100, 4: 0x1_0000, 8: 0x1_0000_0000}
	if value < minimums[length] {
		return 0, "NON_CANONICAL_SYMBOL"
	}
	return value, ""
}

func (reader *cborReader) readInteger() (negative bool, value uint64, code string) {
	head, ok := reader.readByte()
	if !ok {
		return false, 0, "MALFORMED_SYMBOL"
	}
	major := head >> 5
	if major != 0 && major != 1 {
		return false, 0, "MALFORMED_SYMBOL"
	}
	value, code = reader.readUnsigned(head & 0x1f)
	return major == 1, value, code
}

func (reader *cborReader) readBytes32() string {
	head, ok := reader.readByte()
	if !ok || head>>5 != 2 {
		return "MALFORMED_SYMBOL"
	}
	length, code := reader.readUnsigned(head & 0x1f)
	if code != "" {
		return code
	}
	if length != 32 {
		return "MALFORMED_SYMBOL"
	}
	if _, ok := reader.readExact(32); !ok {
		return "MALFORMED_SYMBOL"
	}
	return ""
}

func validateCanonicalSymbol(encoded []byte) string {
	reader := cborReader{bytes: encoded}
	head, ok := reader.readByte()
	if !ok || head != 0x84 {
		return "MALFORMED_SYMBOL"
	}
	negativeIndex, index, code := reader.readInteger()
	if code != "" {
		return code
	}
	if negativeIndex || index > 9_007_199_254_740_991 {
		return "INTEGER_OUT_OF_RANGE"
	}
	_, count, code := reader.readInteger()
	if code != "" {
		return code
	}
	if count > math.MaxInt64 {
		return "INTEGER_OUT_OF_RANGE"
	}
	if code := reader.readBytes32(); code != "" {
		return code
	}
	if code := reader.readBytes32(); code != "" {
		return code
	}
	if reader.offset != len(reader.bytes) {
		return "TRAILING_BYTES"
	}
	return ""
}

func TestProtocolV1Vector(t *testing.T) {
	encoded, err := os.ReadFile("../vectors/protocol-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector vectorFile
	if err := json.Unmarshal(encoded, &vector); err != nil {
		t.Fatal(err)
	}
	if vector.Schema != "dkg-wal-protocol-v1-conformance-v1" {
		t.Fatalf("unexpected schema %q", vector.Schema)
	}
	requester := mustHex(t, vector.RequesterHeadID)
	providerHead := mustHex(t, vector.ProviderHeadID)
	nonce := mustHex(t, vector.RequesterNonce)
	seed := digest(domains["seed"], requester, providerHead, nonce)
	if hex.EncodeToString(seed[:]) != vector.ReconciliationSeed {
		t.Fatal("seed mismatch")
	}

	receiverIDs := hexIDs(t, vector.ReceiverIDs)
	providerIDs := hexIDs(t, vector.ProviderIDs)
	if root := setCommitment(receiverIDs); hex.EncodeToString(root[:]) != vector.ReceiverRoot {
		t.Fatal("receiver root mismatch")
	}
	if root := setCommitment(providerIDs); hex.EncodeToString(root[:]) != vector.ProviderRoot {
		t.Fatal("provider root mismatch")
	}
	for _, fixture := range vector.CommitmentCases {
		root := setCommitment(hexIDs(t, fixture.IDs))
		if hex.EncodeToString(root[:]) != fixture.Root {
			t.Fatalf("commitment case %s mismatch", fixture.Name)
		}
	}

	cursor := mappingCursor{state: mappingSeed(seed[:], mustHex(t, vector.MappingCase.ID))}
	for index, expected := range vector.MappingCase.Indices {
		if actual := nextMapping(&cursor); actual != expected {
			t.Fatalf("mapping index %d: got %d want %d", index, actual, expected)
		}
	}

	providerSymbols := generateSymbols(providerIDs, seed[:], len(vector.Symbols))
	for index, fixture := range vector.Symbols {
		expectedCount, err := strconv.ParseInt(fixture.Count, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		actual := providerSymbols[index]
		if actual.index != fixture.SymbolIndex || actual.count != expectedCount ||
			hex.EncodeToString(actual.idXor[:]) != fixture.IDXor ||
			hex.EncodeToString(actual.checksumXor[:]) != fixture.ChecksumXor ||
			hex.EncodeToString(canonicalCBOR(actual)) != fixture.CanonicalCBOR {
			t.Fatalf("symbol %d mismatch", index)
		}
	}
	receiverSymbols := generateSymbols(receiverIDs, seed[:], len(vector.Symbols))
	decoder := newIncrementalDecoder(seed[:])
	for index := range providerSymbols {
		if !decoder.add(providerSymbols[index], receiverSymbols[index]) {
			t.Fatalf("incremental decode failed at symbol %d", index)
		}
		expectedState := vector.SubtractionStates[index]
		if expectedState.AfterSymbol != index || len(expectedState.Residual) != len(decoder.cells) {
			t.Fatalf("subtraction state %d shape mismatch", index)
		}
		for cellIndex, cell := range decoder.cells {
			if !matchesVectorSymbol(cell, expectedState.Residual[cellIndex]) {
				t.Fatalf("subtraction state %d cell %d mismatch", index, cellIndex)
			}
		}
	}
	sort.Strings(decoder.providerOnly)
	sort.Strings(decoder.receiverOnly)
	complete := decoder.complete()
	if complete != vector.Decode.Complete || fmt.Sprint(decoder.providerOnly) != fmt.Sprint(vector.Decode.ProviderOnly) ||
		fmt.Sprint(decoder.receiverOnly) != fmt.Sprint(vector.Decode.ReceiverOnly) ||
		fmt.Sprint(decoder.trace) != fmt.Sprint(vector.Decode.PeelTrace) {
		t.Fatalf(
			"decode mismatch: complete=%v provider=%v receiver=%v trace=%v",
			complete,
			decoder.providerOnly,
			decoder.receiverOnly,
			decoder.trace,
		)
	}
	reconstructed := map[string]bool{}
	for _, id := range vector.ReceiverIDs {
		reconstructed[id] = true
	}
	for _, id := range decoder.receiverOnly {
		if !reconstructed[id] {
			t.Fatalf("decoded receiver-only ID %s was absent", id)
		}
		delete(reconstructed, id)
	}
	for _, id := range decoder.providerOnly {
		if reconstructed[id] {
			t.Fatalf("decoded provider-only ID %s already existed", id)
		}
		reconstructed[id] = true
	}
	reconstructedHex := make([]string, 0, len(reconstructed))
	for id := range reconstructed {
		reconstructedHex = append(reconstructedHex, id)
	}
	reconstructedRoot := setCommitment(hexIDs(t, reconstructedHex))
	if hex.EncodeToString(reconstructedRoot[:]) != vector.ProviderRoot {
		t.Fatal("decoded difference did not reconstruct provider root")
	}
	for _, fixture := range vector.FailureCases {
		if code := validateCanonicalSymbol(mustHex(t, fixture.CanonicalCBOR)); code != fixture.ExpectedCode {
			t.Fatalf("failure case %s: got %s want %s", fixture.Name, code, fixture.ExpectedCode)
		}
	}

	flattened := []string{}
	for index, page := range vector.FallbackPages {
		if page.HeadID != vector.ProviderHeadID || page.Offset != len(flattened) || page.Done != (index == len(vector.FallbackPages)-1) {
			t.Fatalf("fallback page %d is not bound or contiguous", index)
		}
		flattened = append(flattened, page.IDs...)
	}
	sortedProvider := append([]string{}, vector.ProviderIDs...)
	sort.Strings(sortedProvider)
	if fmt.Sprint(flattened) != fmt.Sprint(sortedProvider) {
		t.Fatal("fallback IDs mismatch")
	}
}
