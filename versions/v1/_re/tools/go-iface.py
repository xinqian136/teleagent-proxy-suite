#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
go-iface.py — 读 Go itab 的接口类型描述符，列出方法名与参数类型。

Go 的 interface type (_type) 里有 methods []imethod，
imethod = { name *_type (指向一个 string 描述符), typ *_type }
imethod.name 指向的结构是 {str *byte, len int}（即 Go string 的 type descriptor）

用法: go-iface.py <exe> <itab_va_hex>
"""
import os, sys, struct, pefile, re

exe = os.path.expanduser('~/.local/share/TeleAgent/runtimes/super-agent-code/bin/TeleAgent.exe')
pe = pefile.PE(exe, fast_load=True)
ib = pe.OPTIONAL_HEADER.ImageBase
raw = open(exe, 'rb').read()


def off(va):
    rva = va - ib
    for s in pe.sections:
        vsz = max(s.Misc_VirtualSize, s.SizeOfRawData)
        if s.VirtualAddress <= rva < s.VirtualAddress + vsz:
            return s.PointerToRawData + (rva - s.VirtualAddress)
    return None


def u64(va):
    o = off(va)
    return struct.unpack_from('<Q', raw, o)[0] if o is not None else 0


def i64(va):
    o = off(va)
    return struct.unpack_from('<q', raw, o)[0] if o is not None else 0


def u32(va):
    o = off(va)
    return struct.unpack_from('<I', raw, o)[0] if o is not None else 0


def gostr(ptr_va):
    """读 Go string：ptr 指向数据，len 在结构体的 +8"""
    o = off(ptr_va)
    if o is None:
        return None
    p = struct.unpack_from('<Q', raw, o)[0]
    ln = struct.unpack_from('<Q', raw, o + 8)[0]
    po = off(p)
    if po is None or ln > 4096:
        return None
    return raw[po:po + ln].decode('utf-8', 'replace')


def typename(tva):
    """读 runtime._type 的字符串名"""
    o = off(tva)
    if o is None:
        return None
    # nameOff int16 在 _type 偏移 0x38（Go 1.21+）附近；用 strdata 相对偏移
    # _type: size(8) ptrdata(8) hash(4) tflag(1) align(1) fieldAlign(1) kind(1)
    #       equal(8) gcdata(8) str(8) ptrToThis(8)
    nameOff = struct.unpack_from('<h', raw, o + 0x38)[0]
    strdata = tva + nameOff
    so = off(strdata)
    if so is None:
        return None
    end = raw.find(b'\x00', so)
    return raw[so:end].decode('utf-8', 'replace')


def main():
    itab_va = int(sys.argv[1], 16)
    io = off(itab_va)
    inter, typ, hashv = struct.unpack_from('<QQQ', raw, io)
    print('itab @0x%x  inter=0x%x  type=0x%x' % (itab_va, inter, typ))

    # interface type: _type + 之后是 *abi.Type 的 tab/数据
    # abi.InterfaceType = { Type; Methods []Imethod }
    # Imethod = { Name Name; Typ Type }
    # Name = { Bytes *byte; Len int }
    to = off(typ)
    if to is None:
        print('type 不可读'); return
    # _type 头部 48 字节（Go 1.21+ abi.Type），Methods 在 +48
    methods_ptr = struct.unpack_from('<Q', raw, to + 48)[0]
    methods_len = struct.unpack_from('<Q', raw, to + 56)[0]
    print('  methods ptr=0x%x len=%d' % (methods_ptr, methods_len))

    mo = off(methods_ptr)
    for i in range(min(methods_len, 16)):
        base = mo + i * 16
        name_ptr = struct.unpack_from('<Q', raw, base)[0]
        name_len = struct.unpack_from('<Q', raw, base + 8)[0]
        typ_va = struct.unpack_from('<Q', raw, base + 16)[0] if False else 0
        # Imethod 是 { Name Name (16B); Typ Type (8B) } → 24B
        typ_va = struct.unpack_from('<Q', raw, base + 16)[0]
        nm = gostr(name_ptr) if name_ptr else None
        if nm is None:
            # name_ptr 可能直接指向字符串数据（非 Name 结构）
            nm = gostr(base)
        print('  [%d] name=%r  typ=0x%x  typname=%s' % (i, nm, typ_va, typename(typ_va)))


if __name__ == '__main__':
    main()
