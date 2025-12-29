import type { CoredumpResponse } from './types'

/**
 * ESP-IDF Coredump Parser
 *
 * This parses ESP-IDF coredump data to extract crash information.
 * Since we can't run addr2line in a Worker, we return raw addresses
 * that can be decoded locally with the ELF file.
 *
 * ESP-IDF coredump format (ELF-based):
 * - ELF header (magic: 0x7f 'E' 'L' 'F')
 * - Program headers (PT_NOTE contains core dump info)
 * - Sections: registers, memory regions, task info
 */

// ESP32 exception causes (from esp-idf)
const EXCEPTION_CAUSES: Record<number, string> = {
    0: 'IllegalInstructionCause',
    1: 'SyscallCause',
    2: 'InstructionFetchErrorCause',
    3: 'LoadStoreErrorCause',
    4: 'Level1InterruptCause',
    5: 'AllocaCause',
    6: 'IntegerDivideByZeroCause',
    8: 'PrivilegedCause',
    9: 'LoadStoreAlignmentCause',
    12: 'InstrPIFDataErrorCause',
    13: 'LoadStorePIFDataErrorCause',
    14: 'InstrPIFAddrErrorCause',
    15: 'LoadStorePIFAddrErrorCause',
    16: 'InstTLBMissCause',
    17: 'InstTLBMultiHitCause',
    18: 'InstFetchPrivilegeCause',
    20: 'InstFetchProhibitedCause',
    24: 'LoadStoreTLBMissCause',
    25: 'LoadStoreTLBMultiHitCause',
    26: 'LoadStorePrivilegeCause',
    28: 'LoadProhibitedCause',
    29: 'StoreProhibitedCause',
}

// Xtensa register names
const REGISTER_NAMES = [
    'PC', 'PS', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
    'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13',
    'A14', 'A15', 'SAR', 'EXCCAUSE', 'EXCVADDR', 'LBEG',
    'LEND', 'LCOUNT', 'THREADPTR', 'SCOMPARE1', 'BR',
    'ACCLO', 'ACCHI', 'M0', 'M1', 'M2', 'M3',
]

interface ParsedCoredump {
    exceptionCause?: number
    pc?: number
    registers: Record<string, number>
    backtraceAddresses: number[]
}

/**
 * Parse base64-encoded coredump data
 */
export function parseCoredump(base64Data: string): CoredumpResponse {
    try {
        // Decode base64
        const binaryString = atob(base64Data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
        }

        const parsed = parseElfCoredump(bytes)

        const registers: Record<string, string> = {}
        for (const [name, value] of Object.entries(parsed.registers)) {
            registers[name] = `0x${value.toString(16).padStart(8, '0')}`
        }

        const backtrace = parsed.backtraceAddresses.map(
            (addr) => `0x${addr.toString(16).padStart(8, '0')}`
        )

        return {
            success: true,
            crash_info: {
                exception_cause: parsed.exceptionCause !== undefined
                    ? EXCEPTION_CAUSES[parsed.exceptionCause] ?? `Unknown (${parsed.exceptionCause})`
                    : undefined,
                pc: parsed.pc !== undefined
                    ? `0x${parsed.pc.toString(16).padStart(8, '0')}`
                    : undefined,
                registers,
            },
            backtrace,
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to parse coredump',
        }
    }
}

/**
 * Parse ELF-formatted coredump
 */
function parseElfCoredump(data: Uint8Array): ParsedCoredump {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

    // Verify ELF magic
    if (
        data[0] !== 0x7f ||
        data[1] !== 0x45 || // 'E'
        data[2] !== 0x4c || // 'L'
        data[3] !== 0x46    // 'F'
    ) {
        throw new Error('Invalid ELF magic - not a valid coredump')
    }

    const isLittleEndian = data[5] === 1
    const is32Bit = data[4] === 1

    if (!is32Bit) {
        throw new Error('Only 32-bit ELF coredumps are supported (ESP32)')
    }

    // Read ELF header fields
    const phoff = view.getUint32(28, isLittleEndian)      // Program header offset
    const phentsize = view.getUint16(42, isLittleEndian)  // Program header entry size
    const phnum = view.getUint16(44, isLittleEndian)      // Number of program headers

    const parsed: ParsedCoredump = {
        registers: {},
        backtraceAddresses: [],
    }

    // Parse program headers looking for PT_NOTE (type 4)
    for (let i = 0; i < phnum; i++) {
        const phStart = phoff + i * phentsize
        const pType = view.getUint32(phStart, isLittleEndian)

        if (pType === 4) { // PT_NOTE
            const pOffset = view.getUint32(phStart + 4, isLittleEndian)
            const pFilesz = view.getUint32(phStart + 16, isLittleEndian)

            parseNoteSection(data, pOffset, pFilesz, isLittleEndian, parsed)
        }
    }

    // Try to extract backtrace from A0 (return address) chain
    if (parsed.registers['A0'] && parsed.registers['A1']) {
        extractBacktrace(data, parsed)
    }

    return parsed
}

/**
 * Parse PT_NOTE section for register and crash info
 */
function parseNoteSection(
    data: Uint8Array,
    offset: number,
    size: number,
    isLittleEndian: boolean,
    parsed: ParsedCoredump
): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let pos = offset
    const end = offset + size

    while (pos < end) {
        // Note header: namesz (4), descsz (4), type (4)
        const namesz = view.getUint32(pos, isLittleEndian)
        const descsz = view.getUint32(pos + 4, isLittleEndian)
        const noteType = view.getUint32(pos + 8, isLittleEndian)

        pos += 12

        // Skip name (aligned to 4 bytes)
        const nameAligned = (namesz + 3) & ~3
        pos += nameAligned

        // Parse descriptor based on type
        if (noteType === 1) {
            // NT_PRSTATUS - process status (contains registers)
            parseRegisters(data, pos, descsz, isLittleEndian, parsed)
        }

        // Skip descriptor (aligned to 4 bytes)
        const descAligned = (descsz + 3) & ~3
        pos += descAligned
    }
}

/**
 * Parse register values from NT_PRSTATUS note
 */
function parseRegisters(
    data: Uint8Array,
    offset: number,
    size: number,
    isLittleEndian: boolean,
    parsed: ParsedCoredump
): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

    // ESP-IDF stores registers after some header info
    // The exact layout depends on the ESP-IDF version
    // This is a simplified extraction

    // Try to find register values (each 4 bytes)
    const numRegs = Math.min(Math.floor(size / 4), REGISTER_NAMES.length)

    for (let i = 0; i < numRegs; i++) {
        const regOffset = offset + i * 4
        if (regOffset + 4 <= data.length) {
            const value = view.getUint32(regOffset, isLittleEndian)
            const name = REGISTER_NAMES[i]
            if (name) {
                parsed.registers[name] = value

                if (name === 'PC') {
                    parsed.pc = value
                }
                if (name === 'EXCCAUSE') {
                    parsed.exceptionCause = value
                }
            }
        }
    }
}

/**
 * Extract backtrace addresses from stack memory
 * This is a heuristic approach - proper backtracing requires debug info
 */
function extractBacktrace(data: Uint8Array, parsed: ParsedCoredump): void {
    // Add PC as the first backtrace entry
    if (parsed.pc !== undefined) {
        parsed.backtraceAddresses.push(parsed.pc)
    }

    // Add A0 (return address) if it looks like code
    const a0 = parsed.registers['A0']
    if (a0 && isValidCodeAddress(a0)) {
        // Xtensa uses CALL/CALLX with return address encoding
        // The actual return address has the window size in the top 2 bits
        const returnAddr = (a0 & 0x3fffffff) | 0x40000000
        parsed.backtraceAddresses.push(returnAddr)
    }

    // Limit backtrace depth without stack walking
    // Full stack walking would require memory dump analysis
}

/**
 * Check if address looks like a valid code address
 * ESP32 code is typically in IRAM (0x40000000-0x40400000) or flash (0x400D0000+)
 */
function isValidCodeAddress(addr: number): boolean {
    return (
        (addr >= 0x40000000 && addr < 0x40400000) || // IRAM
        (addr >= 0x400d0000 && addr < 0x40400000) || // Flash cache
        (addr >= 0x3f400000 && addr < 0x3f800000)    // Flash data
    )
}

